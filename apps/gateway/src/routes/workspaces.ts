import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MeridianError, newId, type PrivacyMode, type RoutingMode, type Workspace as WorkspaceRecord } from '@meridian/shared';
import { Workspace, newTask, taskDiff, type Lane } from '@meridian/agent-sdk';
import type { App } from '../services/app.js';
import { intParam } from './shared.js';

/**
 * Workspaces, files, diff review and agent tasks.
 *
 * The workspace is the unit of isolation: a task runs against one, a privacy
 * mode belongs to one, and an agent can never reach outside one. Every path in
 * this file goes through {@link Workspace} so containment is enforced in one
 * place rather than at each route.
 */
export async function registerWorkspaceRoutes(server: FastifyInstance, app: App): Promise<void> {
  /* ---------------- Workspaces ---------------- */

  server.get('/api/workspaces', async () => ({ workspaces: app.store.listWorkspaces() }));

  server.post<{ Body: { name?: string; repoUrl?: string; branch?: string; privacyMode?: PrivacyMode; defaultMode?: RoutingMode } }>(
    '/api/workspaces',
    async (req) => {
      const body = req.body ?? {};
      const name = (body.name ?? (body.repoUrl ? basename(body.repoUrl, '.git') : '')).trim() || 'Untitled workspace';
      const id = newId('ws');
      const path = resolve(join(app.config.workspaceRoot, id));
      await mkdir(path, { recursive: true });

      const record: WorkspaceRecord = {
        id,
        name,
        path,
        repoUrl: body.repoUrl ?? null,
        branch: body.branch ?? null,
        // A workspace holding a private repository defaults to the stricter
        // posture, so unverified providers are excluded until told otherwise.
        privacyMode: body.privacyMode ?? app.config.defaultPrivacyMode,
        defaultMode: body.defaultMode ?? app.config.defaultRoutingMode,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      };
      app.store.createWorkspace(record);

      if (body.repoUrl) {
        const clone = await app.sandbox.exec(`git clone --depth 50 ${shellQuote(body.repoUrl)} .`, {
          cwd: path,
          timeoutMs: 300_000,
        });
        if (clone.exitCode !== 0) {
          // The workspace stays, empty, with the failure reported: deleting it
          // would discard a name and settings the user just chose.
          return {
            workspace: record,
            clone: { ok: false, detail: (clone.stderr || clone.stdout).slice(0, 2000) },
          };
        }
        if (body.branch) {
          await app.sandbox.exec(`git checkout ${shellQuote(body.branch)}`, { cwd: path, timeoutMs: 60_000 });
        }
      }

      app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'workspace.create', target: id, details: { name, repoUrl: body.repoUrl }, ip: req.ip });
      return { workspace: record, clone: body.repoUrl ? { ok: true } : null };
    },
  );

  server.get<{ Params: { id: string } }>('/api/workspaces/:id', async (req) => {
    const record = app.store.getWorkspace(req.params.id);
    if (!record) throw new MeridianError('invalid_request', 'No such workspace');
    app.store.touchWorkspace(req.params.id);
    const ws = app.workspaceFor(req.params.id)!;
    return { workspace: record, tree: await ws.tree('', 4), changes: ws.pendingChanges() };
  });

  server.patch<{ Params: { id: string }; Body: { name?: string; privacyMode?: PrivacyMode; defaultMode?: RoutingMode; branch?: string } }>(
    '/api/workspaces/:id',
    async (req) => {
      app.store.updateWorkspace(req.params.id, req.body ?? {});
      return { workspace: app.store.getWorkspace(req.params.id) };
    },
  );

  server.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (req) => {
    // The database record goes; the directory is left on disk deliberately, so
    // removing a workspace from the UI can never destroy uncommitted work.
    const removed = app.store.deleteWorkspace(req.params.id);
    app.forgetWorkspace(req.params.id);
    return { removed, note: 'The workspace directory was left on disk. Delete it yourself if you no longer need it.' };
  });

  /* ---------------- Files ---------------- */

  server.get<{ Params: { id: string }; Querystring: { path?: string; depth?: string } }>('/api/workspaces/:id/tree', async (req) => {
    const ws = requireWorkspace(app, req.params.id);
    return { tree: await ws.tree(req.query?.path ?? '', intParam(req.query?.depth, 4, 12)) };
  });

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/workspaces/:id/file', async (req) => {
    const ws = requireWorkspace(app, req.params.id);
    const path = req.query?.path;
    if (!path) throw new MeridianError('invalid_request', '"path" is required');
    return { path, content: await ws.read(path) };
  });

  server.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>('/api/workspaces/:id/file', async (req) => {
    const ws = requireWorkspace(app, req.params.id);
    const body = req.body ?? {};
    if (!body.path) throw new MeridianError('invalid_request', '"path" is required');
    return { change: await ws.write(body.path, body.content ?? '') };
  });

  server.get<{ Params: { id: string }; Querystring: { pattern?: string; glob?: string; ignoreCase?: string } }>(
    '/api/workspaces/:id/search',
    async (req) => {
      const ws = requireWorkspace(app, req.params.id);
      const q = req.query ?? {};
      if (!q.pattern) throw new MeridianError('invalid_request', '"pattern" is required');
      return {
        results: await ws.grep(q.pattern, { glob: q.glob, caseInsensitive: q.ignoreCase === 'true', contextLines: 1 }),
      };
    },
  );

  /* ---------------- Diff review ---------------- */

  server.get<{ Params: { id: string } }>('/api/workspaces/:id/changes', async (req) => {
    const ws = requireWorkspace(app, req.params.id);
    const changes = ws.pendingChanges();
    return { changes, diff: taskDiff(changes) };
  });

  server.post<{ Params: { id: string }; Body: { path?: string; action?: 'accept' | 'reject' } }>(
    '/api/workspaces/:id/changes',
    async (req) => {
      const ws = requireWorkspace(app, req.params.id);
      const { path, action } = req.body ?? {};
      if (action !== 'accept' && action !== 'reject') throw new MeridianError('invalid_request', '"action" must be accept or reject');

      if (!path) {
        const changes = action === 'accept' ? ws.acceptAll() : await ws.rejectAll();
        return { changes };
      }
      const change = action === 'accept' ? ws.accept(path) : await ws.reject(path);
      if (!change) throw new MeridianError('invalid_request', `No pending change for ${path}`);
      return { change };
    },
  );

  /* ---------------- Terminal ---------------- */

  server.post<{ Params: { id: string }; Body: { command?: string; timeoutMs?: number } }>('/api/workspaces/:id/exec', async (req) => {
    const ws = requireWorkspace(app, req.params.id);
    const command = req.body?.command;
    if (!command) throw new MeridianError('invalid_request', '"command" is required');

    const result = await app.sandbox.exec(command, {
      cwd: ws.root,
      timeoutMs: Math.min(req.body?.timeoutMs ?? app.config.sandboxTimeoutMs, app.config.sandboxTimeoutMs),
    });
    app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'workspace.exec', target: req.params.id, details: { command }, ip: req.ip });
    return { ...result, sandbox: { kind: app.sandbox.kind, isolation: app.sandbox.isolationNote } };
  });

  /* ---------------- Tasks ---------------- */

  server.get<{ Querystring: { workspaceId?: string; limit?: string } }>('/api/tasks', async (req) => {
    const tasks = app.store.listTasks(req.query?.workspaceId, intParam(req.query?.limit, 50, 500));
    return { tasks: tasks.map((t) => ({ ...t, running: app.orchestrator.isRunning(t.id) })) };
  });

  server.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const task = app.store.getTask(req.params.id);
    if (!task) throw new MeridianError('invalid_request', 'No such task');
    return {
      task,
      steps: app.store.listSteps(task.id),
      toolCalls: app.store.listToolCalls(task.id),
      usage: app.store.listUsage({ taskId: task.id, limit: 200 }),
      running: app.orchestrator.isRunning(task.id),
    };
  });

  /** Estimate before committing: calls, models, time and cost (spec §59). */
  server.post<{ Body: { workspaceId?: string; request?: string; mode?: RoutingMode; allowPaid?: boolean } }>(
    '/api/tasks/estimate',
    async (req) => {
      const body = req.body ?? {};
      if (!body.request) throw new MeridianError('invalid_request', '"request" is required');
      const pipeline = app.orchestrator.planPipeline(body.request);
      const estimate = app.orchestrator.estimate(body.request, {
        mode: body.mode ?? app.config.defaultRoutingMode,
        workspaceId: body.workspaceId ?? '',
        userId: req.auth.userId,
        allowPaid: body.allowPaid ?? app.preferencesFor(req.auth.userId).allowPaid,
      });
      return { estimate, pipeline };
    },
  );

  server.post<{
    Body: { workspaceId?: string; request?: string; mode?: RoutingMode; allowPaid?: boolean; budget?: number; lane?: string };
  }>('/api/tasks', async (req) => {
    const body = req.body ?? {};
    if (!body.workspaceId || !body.request) throw new MeridianError('invalid_request', '"workspaceId" and "request" are required');
    const record = app.store.getWorkspace(body.workspaceId);
    if (!record) throw new MeridianError('invalid_request', 'No such workspace');
    const ws = requireWorkspace(app, body.workspaceId);

    const prefs = app.preferencesFor(req.auth.userId);
    const mode = body.mode ?? record.defaultMode ?? prefs.routingMode;
    const task = newTask({ workspaceId: body.workspaceId, userId: req.auth.userId, request: body.request, lane: body.lane, mode });
    task.estimate = app.orchestrator.estimate(body.request, {
      mode,
      workspaceId: body.workspaceId,
      userId: req.auth.userId,
      allowPaid: body.allowPaid ?? prefs.allowPaid,
    });
    app.store.saveTask(task);

    // The task runs detached: the HTTP response returns the queued record and
    // progress arrives over the event stream, because a real task outlives any
    // sensible request timeout.
    void app.orchestrator
      .run({
        task,
        workspace: ws,
        mode,
        privacyMode: record.privacyMode,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
        sensitive: record.privacyMode === 'STRICT_LOCAL' || record.privacyMode === 'TRUSTED_ONLY',
        budget: body.budget ?? prefs.maxCostPerTask,
      })
      .catch((e: unknown) => {
        app.logger.error('task crashed', { taskId: task.id, errorCode: e instanceof Error ? e.message : String(e) });
      });

    return { task };
  });

  server.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => ({
    cancelled: app.orchestrator.cancel(req.params.id),
  }));

  /** Explicit feedback on a task, folded into the model's learned scores. */
  server.post<{ Params: { id: string }; Body: { feedback?: 'positive' | 'negative' } }>('/api/tasks/:id/feedback', async (req) => {
    const feedback = req.body?.feedback;
    if (feedback !== 'positive' && feedback !== 'negative') throw new MeridianError('invalid_request', '"feedback" must be positive or negative');
    const rows = app.store.listUsage({ taskId: req.params.id, limit: 200 });
    for (const row of rows) app.recordOutcome(row, { userFeedback: feedback });
    return { applied: rows.length };
  });

  /* ---------------- Parallel lanes ---------------- */

  server.post<{ Body: { workspaceId?: string; lanes?: Lane[]; mode?: RoutingMode; allowPaid?: boolean; concurrency?: number } }>(
    '/api/tasks/parallel',
    async (req) => {
      const body = req.body ?? {};
      if (!body.workspaceId || !body.lanes?.length) throw new MeridianError('invalid_request', '"workspaceId" and "lanes" are required');
      if (body.lanes.length > 6) throw new MeridianError('invalid_request', 'At most six lanes at a time');
      const record = app.store.getWorkspace(body.workspaceId);
      if (!record) throw new MeridianError('invalid_request', 'No such workspace');
      const source = requireWorkspace(app, body.workspaceId);
      const prefs = app.preferencesFor(req.auth.userId);

      // Each lane gets its own copy of the workspace, so lanes cannot overwrite
      // one another's edits.
      const runs = await app.parallel.run(body.lanes, {
        workspaceId: body.workspaceId,
        userId: req.auth.userId,
        source,
        scratchRoot: resolve(join(app.config.workspaceRoot, '.lanes', body.workspaceId)),
        concurrency: Math.min(body.concurrency ?? 3, app.config.maxConcurrentTasks),
        mode: body.mode ?? record.defaultMode,
        privacyMode: record.privacyMode,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
        logger: app.logger,
      });

      const { conflictingPaths, totalUsage } = await import('@meridian/agent-sdk');
      return { runs, conflicts: conflictingPaths(runs), usage: totalUsage(runs) };
    },
  );

  /* ---------------- Git ---------------- */

  server.post<{ Params: { id: string }; Body: { operation?: string; message?: string; branch?: string } }>(
    '/api/workspaces/:id/git',
    async (req) => {
      const ws = requireWorkspace(app, req.params.id);
      const body = req.body ?? {};
      // A fixed command set: the model-facing git tool and this route both
      // refuse to push, so an agent cannot publish anything on its own.
      const commands: Record<string, string> = {
        status: 'git status --porcelain=v1 -b',
        diff: 'git --no-pager diff',
        log: 'git --no-pager log --oneline -30',
        branch: body.branch ? `git checkout -b ${shellQuote(body.branch)}` : 'git branch --show-current',
        stage: 'git add -A',
        commit: `git add -A && git commit -m ${shellQuote(body.message || 'Changes from Meridian')}`,
      };
      const command = commands[body.operation ?? 'status'];
      if (!command) throw new MeridianError('invalid_request', `Unsupported git operation "${body.operation}"`);

      const result = await app.sandbox.exec(command, { cwd: ws.root, timeoutMs: 60_000 });
      return { ...result, note: body.operation === 'commit' ? 'Committed locally. Meridian never pushes on your behalf.' : undefined };
    },
  );
}

function requireWorkspace(app: App, id: string): Workspace {
  const ws = app.workspaceFor(id);
  if (!ws) throw new MeridianError('invalid_request', 'No such workspace');
  return ws;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
