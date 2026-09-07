import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MeridianError } from '@meridian/shared';
import type { App } from '../services/app.js';
import { requireScope } from './authz.js';

/**
 * Version control for workspaces.
 *
 * Every route takes a workspaceId rather than a raw path: the workspace is the
 * authorization boundary, and its stored path is the only place git runs.
 * Credentials are whatever the host environment already has; failures come
 * back verbatim so "you are not authenticated to push" is the actual answer.
 */
export async function registerGitRoutes(server: FastifyInstance, app: App): Promise<void> {
  const git = app.control.git;

  function pathFor(req: { auth: { userId: string | null } }, workspaceId: string): string {
    if (!app.workspaceIdsFor(req.auth.userId).has(workspaceId)) {
      throw new MeridianError('invalid_request', 'No such workspace');
    }
    const record = app.store.getWorkspace(workspaceId);
    if (!record) throw new MeridianError('invalid_request', 'No such workspace');
    return resolve(record.path);
  }

  server.get('/api/git/:workspaceId/status', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    return { status: await git.status(pathFor(req, workspaceId)) };
  });

  server.get('/api/git/:workspaceId/branches', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    return { branches: await git.branches(pathFor(req, workspaceId)) };
  });

  server.post('/api/git/:workspaceId/branches', async (req, reply) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const body = (req.body ?? {}) as { name?: string; from?: string };
    if (!body.name) throw new MeridianError('invalid_request', 'name is required');
    const run = await git.createBranch(pathFor(req, workspaceId), body.name, body.from);
    if (!run.ok) throw new MeridianError('invalid_request', run.stderr.slice(0, 400) || 'branch creation failed');
    reply.code(201);
    return { created: body.name };
  });

  server.post('/api/git/:workspaceId/switch', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name) throw new MeridianError('invalid_request', 'name is required');
    const run = await git.switchBranch(pathFor(req, workspaceId), body.name);
    if (!run.ok) throw new MeridianError('invalid_request', run.stderr.slice(0, 400) || 'switch failed');
    return { switched: body.name };
  });

  server.post('/api/git/:workspaceId/commit', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const body = (req.body ?? {}) as { message?: string; addAll?: boolean };
    if (!body.message) throw new MeridianError('invalid_request', 'message is required');
    const run = await git.commit(pathFor(req, workspaceId), body.message, { addAll: body.addAll ?? true });
    if (!run.ok) throw new MeridianError('invalid_request', (run.stderr || run.stdout).slice(0, 400) || 'commit failed');
    return { committed: true, output: run.stdout.slice(0, 2000) };
  });

  server.post('/api/git/:workspaceId/fetch', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const run = await git.fetch(pathFor(req, workspaceId));
    return { ok: run.ok, output: (run.stdout + run.stderr).slice(0, 4000) };
  });

  server.post('/api/git/:workspaceId/pull', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const run = await git.pull(pathFor(req, workspaceId));
    return { ok: run.ok, output: (run.stdout + run.stderr).slice(0, 4000) };
  });

  server.post('/api/git/:workspaceId/push', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const body = (req.body ?? {}) as { setUpstream?: boolean; branch?: string };
    const run = await git.push(pathFor(req, workspaceId), { setUpstream: body.setUpstream, branch: body.branch ?? null });
    return { ok: run.ok, output: (run.stdout + run.stderr).slice(0, 4000) };
  });

  server.get('/api/git/:workspaceId/log', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const { limit } = (req.query ?? {}) as { limit?: string };
    return { commits: await git.log(pathFor(req, workspaceId), limit ? Number(limit) : 30) };
  });

  server.get('/api/git/:workspaceId/diff', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    return { diff: await git.diffSummary(pathFor(req, workspaceId)) };
  });

  /* ---- GitHub CLI --------------------------------------------------- */

  server.get('/api/git/gh', async (req) => {
    requireScope(req, 'workspaces');
    return { gh: await git.ghInfo() };
  });

  server.post('/api/git/:workspaceId/pr', async (req, reply) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const body = (req.body ?? {}) as { title?: string; body?: string; base?: string; draft?: boolean };
    if (!body.title) throw new MeridianError('invalid_request', 'title is required');
    const run = await git.ghCreatePr(pathFor(req, workspaceId), {
      title: body.title,
      body: body.body ?? '',
      base: body.base,
      draft: body.draft,
    });
    if (!run.ok) throw new MeridianError('invalid_request', (run.stderr || run.stdout).slice(0, 500) || 'gh pr create failed');
    reply.code(201);
    return { url: run.stdout.trim().split('\n').pop() ?? null };
  });

  server.get('/api/git/:workspaceId/prs', async (req) => {
    requireScope(req, 'workspaces');
    const { workspaceId } = req.params as { workspaceId: string };
    const run = await git.ghListPrs(pathFor(req, workspaceId));
    if (!run.ok) throw new MeridianError('invalid_request', (run.stderr || run.stdout).slice(0, 400) || 'gh pr list failed');
    try {
      return { prs: JSON.parse(run.stdout) };
    } catch {
      return { prs: [] };
    }
  });
}
