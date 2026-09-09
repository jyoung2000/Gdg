import { cp, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  MeridianError,
  newId,
  type AgentTask,
  type PipelineKind,
  type PrivacyMode,
  type RoutingMode,
  type Workspace as WorkspaceRecord,
} from '@meridian/shared';
import { Workspace, newTask, taskDiff, type Lane } from '@meridian/agent-sdk';
import { requireScope } from './authz.js';
import type { App } from '../services/app.js';
import { intParam, normalizeMode } from './shared.js';

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

  /**
   * Only the workspaces this caller may reach.
   *
   * A workspace holds source code and can carry its own provider credential, so
   * on a shared instance it is not a public listing. Unowned workspaces stay
   * visible to everyone, which is what a single-user install has.
   */
  server.get('/api/workspaces', async (req) => {
    requireScope(req, 'workspaces');
    const reachable = app.workspaceIdsFor(req.auth.userId);
    return { workspaces: app.store.listWorkspaces().filter((w) => reachable.has(w.id)) };
  });

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
        // Owned by whoever made it. On a single-user install that is the
        // operator, and nothing changes.
        userId: req.auth.userId,
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
    const ws = requireWorkspace(app, req, req.params.id);
    const record = app.store.getWorkspace(req.params.id);
    if (!record) throw new MeridianError('invalid_request', 'No such workspace');
    app.store.touchWorkspace(req.params.id);
    return { workspace: record, tree: await ws.tree('', 4), changes: ws.pendingChanges() };
  });

  server.patch<{ Params: { id: string }; Body: { name?: string; privacyMode?: PrivacyMode; defaultMode?: RoutingMode; branch?: string } }>(
    '/api/workspaces/:id',
    async (req) => {
      requireWorkspace(app, req, req.params.id);
      app.store.updateWorkspace(req.params.id, req.body ?? {});
      return { workspace: app.store.getWorkspace(req.params.id) };
    },
  );

  server.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (req) => {
    requireWorkspace(app, req, req.params.id);
    // The database record goes; the directory is left on disk deliberately, so
    // removing a workspace from the UI can never destroy uncommitted work.
    const removed = app.store.deleteWorkspace(req.params.id);
    app.forgetWorkspace(req.params.id);
    return { removed, note: 'The workspace directory was left on disk. Delete it yourself if you no longer need it.' };
  });

  /* ---------------- Files ---------------- */

  server.get<{ Params: { id: string }; Querystring: { path?: string; depth?: string } }>('/api/workspaces/:id/tree', async (req) => {
    const ws = requireWorkspace(app, req, req.params.id);
    return { tree: await ws.tree(req.query?.path ?? '', intParam(req.query?.depth, 4, 12)) };
  });

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/workspaces/:id/file', async (req) => {
    const ws = requireWorkspace(app, req, req.params.id);
    const path = req.query?.path;
    if (!path) throw new MeridianError('invalid_request', '"path" is required');
    return { path, content: await ws.read(path) };
  });

  server.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>('/api/workspaces/:id/file', async (req) => {
    const ws = requireWorkspace(app, req, req.params.id);
    const body = req.body ?? {};
    if (!body.path) throw new MeridianError('invalid_request', '"path" is required');
    return { change: await ws.write(body.path, body.content ?? '') };
  });

  server.get<{ Params: { id: string }; Querystring: { pattern?: string; glob?: string; ignoreCase?: string } }>(
    '/api/workspaces/:id/search',
    async (req) => {
      const ws = requireWorkspace(app, req, req.params.id);
      const q = req.query ?? {};
      if (!q.pattern) throw new MeridianError('invalid_request', '"pattern" is required');
      return {
        results: await ws.grep(q.pattern, { glob: q.glob, caseInsensitive: q.ignoreCase === 'true', contextLines: 1 }),
      };
    },
  );

  /* ---------------- Diff review ---------------- */

  server.get<{ Params: { id: string } }>('/api/workspaces/:id/changes', async (req) => {
    const ws = requireWorkspace(app, req, req.params.id);
    const changes = ws.pendingChanges();
    return { changes, diff: taskDiff(changes) };
  });

  server.post<{ Params: { id: string }; Body: { path?: string; action?: 'accept' | 'reject' } }>(
    '/api/workspaces/:id/changes',
    async (req) => {
      const ws = requireWorkspace(app, req, req.params.id);
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
    const ws = requireWorkspace(app, req, req.params.id);
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
    requireScope(req, 'workspaces');
    // A task carries the request the user typed and the code the agents wrote,
    // so it is scoped to the workspaces the caller can reach.
    const reachable = app.workspaceIdsFor(req.auth.userId);
    const tasks = app.store
      .listTasks(req.query?.workspaceId, intParam(req.query?.limit, 50, 500))
      .filter((t) => reachable.has(t.workspaceId));
    return { tasks: tasks.map((t) => ({ ...t, running: app.orchestrator.isRunning(t.id) })) };
  });

  server.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const task = requireTask(app, req, req.params.id);
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
      // The estimate exists so the caller can approve a cost. It has to be
      // priced under the mode the task will actually run with — which POST
      // /api/tasks resolves through the workspace's default — or the approval
      // is for a different decision than the one that spends the money.
      const workspaceDefault = body.workspaceId ? app.store.getWorkspace(body.workspaceId)?.defaultMode : undefined;
      const prefs = app.preferencesFor(req.auth.userId);
      const estimate = app.orchestrator.estimate(body.request, {
        mode: normalizeMode(body.mode) ?? workspaceDefault ?? prefs.routingMode,
        workspaceId: body.workspaceId ?? '',
        userId: req.auth.userId,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
      });
      return { estimate, pipeline };
    },
  );

  server.post<{
    Body: { workspaceId?: string; request?: string; mode?: RoutingMode; allowPaid?: boolean; budget?: number; lane?: string; pipeline?: PipelineKind };
  }>('/api/tasks', async (req) => {
    const body = req.body ?? {};
    if (!body.workspaceId || !body.request) throw new MeridianError('invalid_request', '"workspaceId" and "request" are required');
    const record = app.store.getWorkspace(body.workspaceId);
    if (!record) throw new MeridianError('invalid_request', 'No such workspace');
    const ws = requireWorkspace(app, req, body.workspaceId);

    const prefs = app.preferencesFor(req.auth.userId);
    const mode = normalizeMode(body.mode) ?? record.defaultMode ?? prefs.routingMode;
    const task = newTask({ workspaceId: body.workspaceId, userId: req.auth.userId, request: body.request, lane: body.lane, mode });
    task.estimate = app.orchestrator.estimate(body.request, {
      mode,
      workspaceId: body.workspaceId,
      userId: req.auth.userId,
      allowPaid: body.allowPaid ?? prefs.allowPaid,
    });
    app.store.saveTask(task);

    // Whatever MCP servers the control plane says apply to this workspace
    // become tools the agents can actually call. Resolved once per task rather
    // than per step: a task is one unit of work under one configuration, and
    // re-resolving mid-run would let the toolset change under the agent.
    const mcpTools = app.mcpToolsFor({ workspaceId: body.workspaceId, request: body.request });
    if (mcpTools.size) {
      app.logger.info('mcp tools available to task', { taskId: task.id, tools: mcpTools.size });
    }

    // The task runs detached: the HTTP response returns the queued record and
    // progress arrives over the event stream, because a real task outlives any
    // sensible request timeout.
    void app.orchestrator
      .run({
        task,
        workspace: ws,
        pipeline: body.pipeline,
        mode,
        privacyMode: record.privacyMode,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
        sensitive: record.privacyMode === 'STRICT_LOCAL' || record.privacyMode === 'TRUSTED_ONLY',
        budget: body.budget ?? prefs.maxCostPerTask,
        extraTools: mcpTools,
      })
      .catch((e: unknown) => {
        app.logger.error('task crashed', { taskId: task.id, errorCode: e instanceof Error ? e.message : String(e) });
      });

    return { task };
  });

  server.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => {
    requireTask(app, req, req.params.id);
    return { cancelled: app.orchestrator.cancel(req.params.id) };
  });

  /**
   * Branch a task: copy its workspace and run a different request against it.
   *
   * Copying rather than reusing is the point — the original task's work stays
   * exactly as it was, so a fork is a genuine alternative to compare against
   * rather than a destructive retry. With a `checkpointId`, the copy is first
   * rewound to that step, which is how "try this differently from here" works.
   */
  server.post<{ Params: { id: string }; Body: { request?: string; checkpointId?: string; name?: string; mode?: RoutingMode; allowPaid?: boolean } }>(
    '/api/tasks/:id/fork',
    async (req) => {
      const body = req.body ?? {};
      if (!body.request) throw new MeridianError('invalid_request', '"request" is required');
      const source = requireTask(app, req, req.params.id);
      const sourceRecord = app.store.getWorkspace(source.workspaceId);
      if (!sourceRecord) throw new MeridianError('invalid_request', 'The task\'s workspace no longer exists');

      let checkpoint: ReturnType<App['store']['getCheckpoint']> = null;
      if (body.checkpointId) {
        checkpoint = app.store.getCheckpoint(body.checkpointId);
        if (!checkpoint || checkpoint.taskId !== source.id) {
          throw new MeridianError('invalid_request', 'No such checkpoint for this task');
        }
      }

      const id = newId('ws');
      const path = resolve(join(app.config.workspaceRoot, id));
      await mkdir(path, { recursive: true });
      // Same exclusions as a parallel lane: node_modules and dist are large and
      // reproducible, and copying .git would give the fork a history it can
      // commit to under the original's identity.
      await cp(sourceRecord.path, path, {
        recursive: true,
        filter: (src) => !/[/\\](node_modules|\.git|dist|build|\.next|\.turbo|coverage)([/\\]|$)/.test(src),
      });

      const record: WorkspaceRecord = {
        ...sourceRecord,
        id,
        name: body.name ?? `${sourceRecord.name} (fork)`,
        path,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      };
      app.store.createWorkspace(record);

      const ws = requireWorkspace(app, req, id);
      let rewound: { restored: string[]; removed: string[]; skipped: string[] } | null = null;
      if (checkpoint) rewound = await ws.rewind(checkpoint.snapshot);

      const prefs = app.preferencesFor(req.auth.userId);
      const mode = body.mode ?? record.defaultMode ?? prefs.routingMode;
      const task = newTask({ workspaceId: id, userId: req.auth.userId, request: body.request, mode });
      task.estimate = app.orchestrator.estimate(body.request, {
        mode,
        workspaceId: id,
        userId: req.auth.userId,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
      });
      app.store.saveTask(task);

      void app.orchestrator
        .run({
          task,
          workspace: ws,
          mode,
          privacyMode: record.privacyMode,
          allowPaid: body.allowPaid ?? prefs.allowPaid,
          sensitive: record.privacyMode === 'STRICT_LOCAL' || record.privacyMode === 'TRUSTED_ONLY',
          budget: prefs.maxCostPerTask,
        })
        .catch((e: unknown) => {
          app.logger.error('forked task crashed', { taskId: task.id, errorCode: e instanceof Error ? e.message : String(e) });
        });

      app.store.audit({
        actor: req.auth.userId ?? 'anonymous',
        action: 'task.fork',
        target: task.id,
        details: { from: source.id, workspace: id, checkpointId: body.checkpointId ?? null },
        ip: req.ip,
      });

      return { task, workspace: record, forkedFrom: { taskId: source.id, workspaceId: source.workspaceId }, rewound };
    },
  );

  /** Snapshots taken before each step, newest last. */
  server.get<{ Params: { id: string } }>('/api/tasks/:id/checkpoints', async (req) => {
    requireTask(app, req, req.params.id);
    return { checkpoints: app.store.listCheckpoints(req.params.id) };
  });

  /**
   * Take the workspace back to the state before a step ran.
   *
   * Refused while the task is still running: rewinding underneath a live agent
   * would have it write into a tree that changed out from under it, and the
   * result would be neither the old state nor the new one.
   */
  server.post<{ Params: { id: string }; Body: { checkpointId?: string } }>('/api/tasks/:id/rewind', async (req) => {
    const task = requireTask(app, req, req.params.id);
    if (task.status === 'running' || task.status === 'queued') {
      throw new MeridianError('invalid_request', 'Cancel the task before rewinding it — an agent is still working in this workspace.');
    }

    const checkpointId = req.body?.checkpointId;
    if (!checkpointId) throw new MeridianError('invalid_request', '"checkpointId" is required');
    const record = app.store.getCheckpoint(checkpointId);
    if (!record || record.taskId !== task.id) throw new MeridianError('invalid_request', 'No such checkpoint for this task');

    const ws = requireWorkspace(app, req, task.workspaceId);
    const result = await ws.rewind(record.snapshot);

    // Later checkpoints describe a tree that no longer exists; keeping them
    // would offer the user a rewind that silently does the wrong thing.
    const dropped = app.store.deleteCheckpointsAfter(task.id, record.snapshot.at);

    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'task.rewind',
      target: task.id,
      details: { checkpointId, restored: result.restored.length, removed: result.removed.length, droppedCheckpoints: dropped },
      ip: req.ip,
    });
    // A diff is the contents of one person's workspace, so it goes to the
    // task's owner rather than to every connected client.
    app.events.publish({ type: 'task', event: { type: 'diff', changes: ws.pendingChanges() } }, { userId: task.userId });

    return { ...result, checkpoint: { id: record.snapshot.id, label: record.snapshot.label, at: record.snapshot.at }, droppedCheckpoints: dropped };
  });

  /** Explicit feedback on a task, folded into the model's learned scores. */
  server.post<{ Params: { id: string }; Body: { feedback?: 'positive' | 'negative' } }>('/api/tasks/:id/feedback', async (req) => {
    requireTask(app, req, req.params.id);
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
      const source = requireWorkspace(app, req, body.workspaceId);
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
      const ws = requireWorkspace(app, req, req.params.id);
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

/**
 * The live workspace, if this caller may reach it.
 *
 * Every route that touches a workspace goes through here, which is the only way
 * a check like this stays applied: a new route that forgets it does not compile,
 * because there is no other way to get the Workspace it needs.
 *
 * A workspace belonging to someone else is reported as absent rather than
 * forbidden — "not yours" confirms it exists, which is an enumeration oracle.
 */
/**
 * The task, if this caller may reach the workspace it belongs to.
 *
 * Task ids are opaque but not secret, and a task holds the user's request and
 * the agents' output. A task in someone else's workspace reads as absent, for
 * the same reason the workspace does.
 */
function requireTask(app: App, req: FastifyRequest, id: string): AgentTask {
  requireScope(req, 'workspaces');
  const task = app.store.getTask(id);
  if (!task || !app.workspaceIdsFor(req.auth.userId).has(task.workspaceId)) {
    throw new MeridianError('invalid_request', 'No such task');
  }
  return task;
}

function requireWorkspace(app: App, req: FastifyRequest, id: string): Workspace {
  requireScope(req, 'workspaces');
  if (!app.workspaceIdsFor(req.auth.userId).has(id)) {
    throw new MeridianError('invalid_request', 'No such workspace');
  }
  const ws = app.workspaceFor(id);
  if (!ws) throw new MeridianError('invalid_request', 'No such workspace');
  return ws;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
