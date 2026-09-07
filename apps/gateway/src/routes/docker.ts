import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MeridianError } from '@meridian/shared';
import { runVerifyLoop, type DockerProjectInfo, type VerifyLoopResult } from '@meridian/docker-sdk';
import type { App } from '../services/app.js';
import { requireAdmin, requireScope } from './authz.js';

/**
 * Docker development orchestration.
 *
 * Reaching the Docker daemon is host-level power, so mutating operations are
 * administrator-gated, and project paths must live inside a workspace this
 * caller can already reach — the Docker API must not become a way to point
 * builds at arbitrary host directories.
 */
export async function registerDockerRoutes(server: FastifyInstance, app: App): Promise<void> {
  const docker = app.control.docker;

  /** A path is buildable when it sits inside an accessible workspace root. */
  function authorizedPath(req: { auth: { userId: string | null; role: string } }, path: string): string {
    const abs = resolve(path);
    if (req.auth.role === 'admin') return abs;
    const roots = [resolve(app.config.workspaceRoot)];
    for (const id of app.workspaceIdsFor(req.auth.userId)) {
      const w = app.store.getWorkspace(id);
      if (w) roots.push(resolve(w.path));
    }
    if (roots.some((root) => abs === root || abs.startsWith(`${root}/`))) return abs;
    throw new MeridianError('invalid_request', 'That path is outside your workspaces');
  }

  server.get('/api/docker/status', async (req) => {
    requireScope(req, 'workspaces');
    return { docker: await docker.detectDocker() };
  });

  server.post('/api/docker/detect', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as { path?: string };
    if (!body.path) throw new MeridianError('invalid_request', 'path is required');
    const project = await docker.detectProject(authorizedPath(req, body.path));
    return { project, isolationName: docker.projectName(project.path) };
  });

  const projectOf = async (req: { auth: { userId: string | null; role: string }; body?: unknown }): Promise<DockerProjectInfo> => {
    const body = (req.body ?? {}) as { path?: string };
    if (!body.path) throw new MeridianError('invalid_request', 'path is required');
    const project = await docker.detectProject(authorizedPath(req as never, body.path));
    if (project.kind === 'none') throw new MeridianError('invalid_request', 'No Dockerfile or compose file in that path');
    return project;
  };

  server.post('/api/docker/build', async (req) => {
    requireAdmin(req);
    const project = await projectOf(req);
    const body = (req.body ?? {}) as { buildArgs?: Record<string, string> };
    const result = await docker.build(project, { buildArgs: body.buildArgs });
    return { ok: result.ok, exitCode: result.exitCode, output: (result.stdout + result.stderr).slice(-20_000), durationMs: result.durationMs };
  });

  server.post('/api/docker/up', async (req) => {
    requireAdmin(req);
    const project = await projectOf(req);
    const result = await docker.up(project);
    return { ok: result.ok, exitCode: result.exitCode, output: (result.stdout + result.stderr).slice(-10_000) };
  });

  server.post('/api/docker/down', async (req) => {
    requireAdmin(req);
    const project = await projectOf(req);
    const result = await docker.down(project);
    return { ok: result.ok, output: (result.stdout + result.stderr).slice(-10_000) };
  });

  server.post('/api/docker/ps', async (req) => {
    requireScope(req, 'workspaces');
    const project = await projectOf(req);
    return { containers: await docker.ps(project) };
  });

  server.post('/api/docker/logs', async (req) => {
    requireScope(req, 'workspaces');
    const project = await projectOf(req);
    const body = (req.body ?? {}) as { service?: string; tail?: number };
    return { logs: await docker.logs(project, { service: body.service, tail: body.tail }) };
  });

  server.post('/api/docker/exec', async (req) => {
    requireAdmin(req);
    const project = await projectOf(req);
    const body = (req.body ?? {}) as { command?: string[]; service?: string };
    if (!Array.isArray(body.command) || body.command.length === 0) {
      throw new MeridianError('invalid_request', 'command is required as an argv array');
    }
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'docker.exec',
      target: docker.projectName(project.path),
      details: { command: body.command.join(' ').slice(0, 300) },
      ip: (req as { ip?: string }).ip ?? '',
    });
    const result = await docker.execIn(project, body.command.map(String), { service: body.service });
    return { ok: result.ok, exitCode: result.exitCode, output: (result.stdout + result.stderr).slice(-20_000) };
  });

  /* ---- The verify loop, as a background job ------------------------- */

  interface VerifyJob {
    id: string;
    path: string;
    startedAt: number;
    finishedAt: number | null;
    status: 'running' | 'done' | 'failed';
    log: string[];
    result: VerifyLoopResult | null;
    error: string | null;
  }
  const jobs = new Map<string, VerifyJob>();

  server.post('/api/docker/verify', async (req, reply) => {
    requireAdmin(req);
    const project = await projectOf(req);
    const body = (req.body ?? {}) as {
      buildArgs?: Record<string, string>;
      testCommand?: string[];
      browserCheck?: { url?: string; expectText?: string } | false;
      retryBudget?: number;
    };

    const job: VerifyJob = {
      id: `vj_${randomUUID().slice(0, 10)}`,
      path: project.path,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      log: [],
      result: null,
      error: null,
    };
    jobs.set(job.id, job);
    if (jobs.size > 50) {
      const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest && oldest.status !== 'running') jobs.delete(oldest.id);
    }

    // Default browser leg: navigate to the app and take a snapshot; optional
    // expected text makes it an assertion rather than a screenshot tour.
    const browserCheck =
      body.browserCheck === false
        ? null
        : async (baseUrl: string): Promise<{ ok: boolean; detail: string }> => {
            const session = await app.control.browser.createSession({ task: `verify ${project.path}`, idleTimeoutMs: 120_000 });
            try {
              let snap = await app.control.browser.navigate(session.id, baseUrl);
              for (let i = 0; i < 4 && snap.text.trim().length < 10; i++) {
                await app.control.browser.wait(session.id, { ms: 700 });
                snap = await app.control.browser.snapshot(session.id);
              }
              const expect = body.browserCheck && typeof body.browserCheck === 'object' ? body.browserCheck.expectText : undefined;
              if (expect && !snap.text.includes(expect)) {
                return { ok: false, detail: `expected text "${expect}" not found; page says: ${snap.text.slice(0, 200)}` };
              }
              return { ok: true, detail: `page loaded: "${snap.title}" with ${snap.elements.length} interactive element(s)` };
            } finally {
              await app.control.browser.closeSession(session.id).catch(() => undefined);
            }
          };

    void runVerifyLoop({
      orchestrator: docker,
      project,
      buildArgs: body.buildArgs,
      testCommand: body.testCommand?.map(String) ?? null,
      browserCheck,
      retryBudget: body.retryBudget,
      onLog: (line) => {
        job.log.push(line.slice(0, 300));
        if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
      },
    })
      .then((result) => {
        job.result = result;
        job.status = result.ok ? 'done' : 'failed';
        job.finishedAt = Date.now();
      })
      .catch((e: unknown) => {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
        job.finishedAt = Date.now();
      });

    reply.code(202);
    return { jobId: job.id };
  });

  server.get('/api/docker/verify/:id', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) throw new MeridianError('invalid_request', `No verify job ${id}`);
    return { job };
  });

  server.get('/api/docker/verify', async (req) => {
    requireScope(req, 'workspaces');
    return {
      jobs: [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 20)
        .map((j) => ({ id: j.id, path: j.path, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt })),
    };
  });
}
