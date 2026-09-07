import type { FastifyInstance } from 'fastify';
import { MeridianError } from '@meridian/shared';
import { curatedCatalog, searchOfficialRegistry, type CatalogEntry, type McpPermissionLevel } from '@meridian/mcp-sdk';
import type { App } from '../services/app.js';
import { requireAdmin, requireScope } from './authz.js';

/**
 * The MCP Control Center's API.
 *
 * Two invariants hold everywhere here: stored secret values never travel back
 * out except through the one explicit, audited reveal route, and installation
 * never executes anything the user has not been shown — the plan endpoint
 * returns exactly the command that would run, and confirm stores it as a
 * server spec whose execution is the documented command itself, argv-style.
 */
export async function registerMcpRoutes(server: FastifyInstance, app: App): Promise<void> {
  const mcp = app.control.mcp;

  /* ---- Catalog & registry ------------------------------------------ */

  server.get('/api/mcp/catalog', async (req) => {
    requireScope(req, 'workspaces');
    const { q } = (req.query ?? {}) as { q?: string };
    const curated = curatedCatalog().filter(
      (c) => !q || `${c.name} ${c.title} ${c.description} ${c.category}`.toLowerCase().includes(q.toLowerCase()),
    );
    let registry: CatalogEntry[] = [];
    let registryError: string | null = null;
    try {
      registry = await searchOfficialRegistry(q ?? '', 20);
    } catch (e) {
      // The registry being down must not take the curated catalog with it.
      registryError = e instanceof Error ? e.message : String(e);
    }
    return { curated, registry, registryError };
  });

  /* ---- Servers ------------------------------------------------------ */

  server.get('/api/mcp/servers', async (req) => {
    requireScope(req, 'workspaces');
    return {
      servers: mcp.listServers().map((s) => ({ ...s, warnings: mcp.warningsFor(s.id), health: mcp.healthOf(s.id) })),
    };
  });

  server.post('/api/mcp/servers', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Parameters<typeof mcp.addServer>[0];
    if (!body?.name || !body.transport) throw new MeridianError('invalid_request', 'name and transport are required');
    const spec = await mcp.addServer(body);
    reply.code(201);
    return { server: mcp.getServer(spec.id), warnings: mcp.warningsFor(spec.id) };
  });

  server.patch('/api/mcp/servers/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const spec = await mcp.updateServer(id, (req.body ?? {}) as Parameters<typeof mcp.updateServer>[1]);
    return { server: mcp.getServer(spec.id), warnings: mcp.warningsFor(spec.id) };
  });

  server.delete('/api/mcp/servers/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await mcp.removeServer(id);
    return { deleted: true };
  });

  server.post('/api/mcp/servers/:id/connect', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const { tools, health } = await mcp.connect(id);
    return { tools, health };
  });

  server.post('/api/mcp/servers/:id/disconnect', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    await mcp.disconnect(id);
    return { disconnected: true };
  });

  server.get('/api/mcp/servers/:id/health', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { health: await mcp.checkHealth(id) };
  });

  server.get('/api/mcp/servers/:id/tools', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { tools: mcp.toolsOf(id) };
  });

  /** The one deliberate secret read-back. Admin, audited. */
  server.post('/api/mcp/servers/:id/reveal', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name) throw new MeridianError('invalid_request', 'name is required');
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'mcp.secret.reveal',
      target: `${id}:${body.name}`,
      details: { note: 'sealed value revealed to administrator' },
      ip: req.ip,
    });
    return { name: body.name, value: await mcp.revealSecret(id, body.name) };
  });

  /* ---- Install flow ------------------------------------------------- */

  // Step 1: the plan. Nothing executes; the response is exactly what would.
  server.post('/api/mcp/install/plan', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as { catalogId?: string; planIndex?: number; q?: string };
    const entry = await findCatalogEntry(body.catalogId ?? '', body.q);
    const plan = entry.installs[body.planIndex ?? 0];
    if (!plan) throw new MeridianError('invalid_request', 'No such install plan');
    return {
      entry: { id: entry.id, title: entry.title, description: entry.description, homepage: entry.homepage },
      plan,
      envHints: entry.envHints,
      suggestedPermissionLevel: entry.suggestedPermissionLevel,
      note: 'Nothing has been installed or executed. Confirming stores this exact command as a server; it runs when the server is connected.',
    };
  });

  // Step 2: confirm. Stores the shown plan as a server spec; secrets seal.
  server.post('/api/mcp/install/confirm', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as {
      catalogId?: string;
      planIndex?: number;
      q?: string;
      name?: string;
      env?: { name: string; value: string; secret?: boolean }[];
      headers?: { name: string; value: string; secret?: boolean }[];
      permissionLevel?: McpPermissionLevel;
      extraArgs?: string[];
    };
    const entry = await findCatalogEntry(body.catalogId ?? '', body.q);
    const plan = entry.installs[body.planIndex ?? 0];
    if (!plan) throw new MeridianError('invalid_request', 'No such install plan');
    const spec = await mcp.addServer({
      name: body.name ?? entry.name,
      description: entry.description,
      transport: plan.transport,
      command: plan.command,
      args: [...plan.args, ...(body.extraArgs ?? []).slice(0, 10).map(String)],
      url: plan.url,
      env: body.env,
      headers: body.headers,
      permissionLevel: body.permissionLevel ?? entry.suggestedPermissionLevel,
      source: entry.source === 'curated' ? 'curated' : 'official-registry',
    });
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'mcp.install',
      target: spec.id,
      details: { command: plan.display },
      ip: req.ip,
    });
    reply.code(201);
    return { server: mcp.getServer(spec.id), warnings: mcp.warningsFor(spec.id) };
  });

  async function findCatalogEntry(catalogId: string, q?: string): Promise<CatalogEntry> {
    const curated = curatedCatalog().find((c) => c.id === catalogId);
    if (curated) return curated;
    if (catalogId.startsWith('reg:')) {
      const results = await searchOfficialRegistry(q ?? catalogId.slice(4), 50);
      const hit = results.find((r) => r.id === catalogId);
      if (hit) return hit;
    }
    throw new MeridianError('invalid_request', `No catalog entry ${catalogId}`);
  }

  /* ---- Playground ---------------------------------------------------- */

  server.post('/api/mcp/servers/:id/call', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { tool?: string; args?: Record<string, unknown>; workspaceId?: string; sessionId?: string };
    if (!body.tool) throw new MeridianError('invalid_request', 'tool is required');
    const started = Date.now();
    const result = await mcp.callTool(id, body.tool, body.args ?? {}, { workspaceId: body.workspaceId, sessionId: body.sessionId });
    return { ...result, latencyMs: Date.now() - started };
  });

  /* ---- Policies & presets -------------------------------------------- */

  server.get('/api/mcp/policies', async (req) => {
    requireScope(req, 'workspaces');
    return { policies: mcp.listPolicies() };
  });

  server.post('/api/mcp/policies', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as {
      scope?: 'global' | 'workspace' | 'session';
      scopeId?: string | null;
      serverId?: string;
      allowTools?: string[];
      denyTools?: string[];
      enabled?: boolean;
      id?: string;
    };
    if (!body.serverId || !body.scope) throw new MeridianError('invalid_request', 'serverId and scope are required');
    if (body.scope !== 'global' && !body.scopeId) throw new MeridianError('invalid_request', `${body.scope} policies need a scopeId`);
    const policy = await mcp.setPolicy({
      id: body.id,
      scope: body.scope,
      scopeId: body.scope === 'global' ? null : (body.scopeId ?? null),
      serverId: body.serverId,
      allowTools: (body.allowTools ?? []).slice(0, 200),
      denyTools: (body.denyTools ?? []).slice(0, 200),
      enabled: body.enabled ?? true,
    });
    reply.code(201);
    return { policy };
  });

  server.delete('/api/mcp/policies/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await mcp.deletePolicy(id);
    return { deleted: true };
  });

  server.get('/api/mcp/presets', async (req) => {
    requireScope(req, 'workspaces');
    return { presets: mcp.listPresets() };
  });

  server.post('/api/mcp/presets', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as { id?: string; name?: string; description?: string; serverIds?: string[] };
    if (!body.name) throw new MeridianError('invalid_request', 'name is required');
    const preset = await mcp.savePreset({
      id: body.id,
      name: body.name,
      description: body.description ?? '',
      serverIds: (body.serverIds ?? []).slice(0, 100),
    });
    reply.code(201);
    return { preset };
  });

  server.post('/api/mcp/presets/:id/apply', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await mcp.applyPreset(id);
    return { applied: true, servers: mcp.listServers().map((s) => ({ id: s.id, enabled: s.enabled })) };
  });

  server.delete('/api/mcp/presets/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await mcp.deletePreset(id);
    return { deleted: true };
  });
}
