import type { FastifyInstance } from 'fastify';
import { MeridianError, type Assignment, type Capability, type ModelDescriptor } from '@meridian/shared';
import { explainResolution, matchModel, parseRequirement, searchCapabilities, capabilityState } from '@meridian/control-sdk';
import type { App } from '../services/app.js';
import { requireAdmin, requireScope } from './authz.js';

/**
 * The AI control plane's API: skills, AI profiles, scoped assignments,
 * capability search, effective configuration, and connections.
 *
 * Reads are open to any caller with the workspaces scope because they are how
 * the UI explains itself; writes are administrative, because an assignment
 * silently changes what every future request is given.
 */
export async function registerControlPlaneRoutes(server: FastifyInstance, app: App): Promise<void> {
  const { skills, profiles, scheduler } = app.ai;

  /** How the model can actually be reached right now — never assumed. */
  const availabilityOf = (model: ModelDescriptor) => {
    const descriptor = app.providers.descriptor(model.providerId);
    const credentialed = descriptor ? descriptor.auth === 'none' || app.credentials.hasAny(model.providerId) : false;
    const enabled = app.providers.isEnabled(model.providerId);
    const health = app.health.get(model.providerId);
    const healthy = !health || health.circuit !== 'open';
    return {
      available: Boolean(descriptor) && credentialed && enabled && healthy,
      local: Boolean(descriptor?.local),
      detail: !descriptor
        ? 'its provider is not registered'
        : !enabled
          ? 'its provider is disabled'
          : !credentialed
            ? 'no credential is configured for its provider'
            : !healthy
              ? 'its provider is in a failure cooldown'
              : null,
    };
  };

  /* ---- Skills ------------------------------------------------------ */

  server.get('/api/skills', async (req) => {
    requireScope(req, 'workspaces');
    return { skills: skills.list() };
  });

  server.post('/api/skills', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as { slug?: string; name?: string; content?: string; description?: string; tags?: string[]; requiresCapabilities?: Capability[] };
    if (!body.slug || !body.name || !body.content) throw new MeridianError('invalid_request', 'slug, name and content are required');
    const skill = await skills.create({
      slug: body.slug,
      name: body.name,
      content: body.content,
      description: body.description,
      tags: body.tags,
      requiresCapabilities: body.requiresCapabilities,
    });
    app.events.publish({ type: 'control-plane', kind: 'skill', detail: `created ${skill.slug}` });
    reply.code(201);
    return { skill };
  });

  server.patch('/api/skills/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const skill = await skills.update(id, (req.body ?? {}) as Record<string, never>);
    app.events.publish({ type: 'control-plane', kind: 'skill', detail: `updated ${skill.slug}` });
    return { skill };
  });

  server.delete('/api/skills/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const skill = skills.get(id);
    await skills.remove(id);
    // The assignments pointed at a deleted skill are dead weight and would
    // resurrect if the slug were reused.
    if (skill) {
      for (const a of profiles.listAssignments('skill').filter((x) => x.targetId === skill.slug)) {
        await profiles.removeAssignment(a.id);
      }
    }
    app.events.publish({ type: 'control-plane', kind: 'skill', detail: `deleted ${id}` });
    return { deleted: true };
  });

  /** Import a skill by slug, replacing rather than duplicating. */
  server.post('/api/skills/import', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as { skills?: { slug: string; name: string; content: string; description?: string; tags?: string[] }[] };
    if (!Array.isArray(body.skills) || !body.skills.length) throw new MeridianError('invalid_request', 'skills[] is required');
    const imported = [];
    for (const s of body.skills.slice(0, 100)) imported.push(await skills.importSkill({ ...s, source: 'imported' }));
    app.events.publish({ type: 'control-plane', kind: 'skill', detail: `imported ${imported.length}` });
    reply.code(201);
    return { imported: imported.length, skills: imported };
  });

  server.get('/api/skills/export', async (req) => {
    requireScope(req, 'workspaces');
    // Content only: no ids, no assignments, so an export can be imported into
    // another instance without carrying this one's internal identifiers.
    return {
      skills: skills.list().map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        content: s.content,
        tags: s.tags,
        requiresCapabilities: s.requiresCapabilities,
      })),
    };
  });

  /* ---- Assignments -------------------------------------------------- */

  server.get('/api/assignments', async (req) => {
    requireScope(req, 'workspaces');
    const { kind } = (req.query ?? {}) as { kind?: 'skill' | 'mcp' };
    return { assignments: profiles.listAssignments(kind) };
  });

  server.put('/api/assignments', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as {
      kind?: 'skill' | 'mcp';
      targetId?: string;
      scope?: Assignment['scope'];
      scopeId?: string | null;
      mode?: 'include' | 'exclude' | 'inherit';
    };
    if (!body.kind || !body.targetId || !body.scope) throw new MeridianError('invalid_request', 'kind, targetId and scope are required');

    // "inherit" is not a stored state: it is the absence of an assignment, so
    // clearing is how a scope gives up its opinion and lets a broader one win.
    if (body.mode === 'inherit') {
      const cleared = await profiles.clearAssignment({ kind: body.kind, targetId: body.targetId, scope: body.scope, scopeId: body.scopeId });
      app.events.publish({ type: 'control-plane', kind: 'assignment', detail: `${body.kind} ${body.targetId} inherits at ${body.scope}` });
      return { cleared };
    }
    if (body.mode !== 'include' && body.mode !== 'exclude') {
      throw new MeridianError('invalid_request', 'mode must be include, exclude or inherit');
    }
    const assignment = await profiles.setAssignment({
      kind: body.kind,
      targetId: body.targetId,
      scope: body.scope,
      scopeId: body.scopeId,
      mode: body.mode,
    });
    app.events.publish({ type: 'control-plane', kind: 'assignment', detail: `${body.kind} ${body.targetId} ${body.mode} at ${body.scope}` });
    return { assignment };
  });

  /* ---- AI profiles --------------------------------------------------- */

  server.get('/api/ais', async (req) => {
    requireScope(req, 'workspaces');
    return { profiles: profiles.listProfiles() };
  });

  server.post('/api/ais', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name) throw new MeridianError('invalid_request', 'name is required');
    const profile = await profiles.createProfile(body as { name: string });
    app.events.publish({ type: 'control-plane', kind: 'profile', detail: `created ${profile.name}` });
    reply.code(201);
    return { profile };
  });

  server.patch('/api/ais/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const profile = await profiles.updateProfile(id, (req.body ?? {}) as Record<string, never>);
    app.events.publish({ type: 'control-plane', kind: 'profile', detail: `updated ${profile.name}` });
    return { profile };
  });

  server.delete('/api/ais/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await profiles.removeProfile(id);
    app.events.publish({ type: 'control-plane', kind: 'profile', detail: `deleted ${id}` });
    return { deleted: true };
  });

  /* ---- Effective configuration ---------------------------------------- */

  /**
   * Exactly what an AI will be given, and why. The debugging surface for the
   * whole precedence system, and the same computation the runtime uses.
   */
  server.get('/api/runtime/effective-config', async (req) => {
    requireScope(req, 'workspaces');
    const q = (req.query ?? {}) as { profileId?: string; modelId?: string; providerId?: string; workspaceId?: string; sessionId?: string };
    const config = profiles.effectiveConfig({
      profileId: q.profileId ?? null,
      modelId: q.modelId ?? null,
      providerId: q.providerId ?? null,
      workspaceId: q.workspaceId ?? null,
      sessionId: q.sessionId ?? null,
    });
    return {
      config,
      // The sentences the UI shows next to each row, computed once here so the
      // API and the UI can never disagree about the explanation.
      explanations: {
        skills: Object.fromEntries(config.skills.map((s) => [s.skill.slug, explainResolution(s.reason)])),
        excludedSkills: Object.fromEntries(config.excludedSkills.map((r) => [r.targetId, r.blocked ?? explainResolution(r)])),
        mcpServers: Object.fromEntries(config.mcpServers.map((m) => [m.serverId, explainResolution(m.reason)])),
        excludedMcpServers: Object.fromEntries(config.excludedMcpServers.map((r) => [r.targetId, r.blocked ?? explainResolution(r)])),
      },
    };
  });

  /* ---- Capability search ----------------------------------------------- */

  server.post('/api/runtime/capability-search', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as {
      query?: string;
      capabilities?: Capability[];
      modalities?: string[];
      minContextLength?: number;
      localOnly?: boolean;
      availableOnly?: boolean;
      requiresMcp?: boolean;
      limit?: number;
    };
    // A plain-language query is parsed into a requirement, and the derived
    // requirement is returned so a wrong reading is visible and correctable.
    const requirement = body.query
      ? parseRequirement(body.query)
      : {
          capabilities: body.capabilities ?? ['text'],
          modalities: body.modalities as never,
          minContextLength: body.minContextLength,
          localOnly: body.localOnly,
          availableOnly: body.availableOnly,
          requiresMcp: body.requiresMcp,
        };
    const matches = searchCapabilities(app.models.all(), requirement, availabilityOf);
    return { requirement, matches: matches.slice(0, Math.min(body.limit ?? 25, 100)), total: matches.length };
  });

  /**
   * Probe models for real and record what came back.
   *
   * Admin-only and never automatic: every probe is a live request against a
   * provider's rate limit and, on a paid model, their meter. The response
   * distinguishes the three outcomes explicitly — what was verified, what was
   * definitively refused, and what reached no verdict and therefore changed
   * nothing.
   */
  server.post('/api/verification/run', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as {
      modelIds?: string[];
      providerId?: string;
      capabilities?: Capability[];
      limit?: number;
      timeoutMs?: number;
    };

    const report = await app.verification.verify({
      modelIds: body.modelIds,
      providerId: body.providerId,
      capabilities: body.capabilities,
      limit: body.limit,
      timeoutMs: body.timeoutMs,
    });

    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'verification.run',
      target: body.providerId ?? body.modelIds?.join(',') ?? 'all',
      details: { probed: String(report.probed), claimsWritten: String(report.claimsWritten) },
      ip: req.ip,
    });

    return {
      probed: report.probed,
      claimsWritten: report.claimsWritten,
      inconclusive: report.inconclusive,
      durationMs: report.finishedAt - report.startedAt,
      skipped: report.skipped,
      models: report.reports.map((r) => ({
        modelId: r.modelId,
        providerId: r.providerId,
        results: r.results,
      })),
    };
  });

  /** Per-capability evidence for one model — the capability inspector's data. */
  server.get('/api/models/:id/capabilities', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const model = app.models.get(decodeURIComponent(id));
    if (!model) throw new MeridianError('invalid_request', `No model ${id}`);
    const vocabulary: Capability[] = [
      'text',
      'vision',
      'tools',
      'json-mode',
      'structured-output',
      'streaming',
      'reasoning',
      'long-context',
      'image-generation',
      'image-editing',
      'video-generation',
      'speech-synthesis',
      'transcription',
      'embedding',
      'prefix-caching',
    ];
    return {
      modelId: model.id,
      providerId: model.providerId,
      displayName: model.displayName,
      contextLength: model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
      modalities: model.modalities,
      pricing: model.pricing,
      discoveredAt: model.discoveredAt ?? null,
      lastVerifiedAt: model.lastVerifiedAt ?? null,
      availability: availabilityOf(model),
      capabilities: vocabulary.map((c) => ({ capability: c, ...capabilityState(model, c) })),
    };
  });

  /** Confirm or deny a capability by hand — the strongest non-probe evidence. */
  server.post('/api/models/:id/capabilities', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const modelId = decodeURIComponent(id);
    const model = app.models.get(modelId);
    if (!model) throw new MeridianError('invalid_request', `No model ${modelId}`);
    const body = (req.body ?? {}) as { capability?: Capability; supported?: boolean };
    if (!body.capability || typeof body.supported !== 'boolean') {
      throw new MeridianError('invalid_request', 'capability and supported are required');
    }
    const at = Date.now();
    const claims = { ...(model.capabilityClaims ?? {}) };
    claims[body.capability] = {
      state: body.supported ? 'user_confirmed' : 'unsupported',
      source: `confirmed by ${req.auth.userId ?? 'operator'}`,
      confidence: 0.95,
      at,
    };
    const capabilities = body.supported
      ? [...new Set([...model.capabilities, body.capability])]
      : model.capabilities.filter((c) => c !== body.capability);
    const next: ModelDescriptor = { ...model, capabilities, capabilityClaims: claims, updatedAt: at };
    app.models.upsert(next);
    app.store.upsertModels([next]);
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'model.capability.confirm',
      target: modelId,
      details: { capability: body.capability, supported: body.supported },
      ip: req.ip,
    });
    return { model: next };
  });

  /* ---- Model discovery and history ------------------------------------- */

  server.post('/api/models/discover', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as { force?: boolean };
    const result = await app.discovery.runOnce({ force: body.force === true });
    return result;
  });

  server.get('/api/models/changes', async (req) => {
    requireScope(req, 'workspaces');
    const { limit } = (req.query ?? {}) as { limit?: string };
    return { changes: app.store.listModelChanges(limit ? Number(limit) : 100) };
  });

  server.get('/api/models/discovery-status', async (req) => {
    requireScope(req, 'workspaces');
    return {
      schedules: scheduler.all(),
      intervalMs: app.config.discoveryIntervalMs,
    };
  });

  /* ---- Connections ------------------------------------------------------ */

  /**
   * What each provider connection actually is.
   *
   * `grants` says in words what the connection buys — API-billed usage versus
   * an account/subscription — because presenting an API key as a subscription
   * would misrepresent what the user is paying for.
   */
  server.get('/api/connections', async (req) => {
    requireScope(req, 'workspaces');
    const credentials = app.store.listCredentials();
    return {
      connections: app.providers.list().map((d) => {
        const mine = credentials.filter((c) => c.providerId === d.id);
        const health = app.health.get(d.id);
        const models = app.models.all().filter((m) => m.providerId === d.id).length;
        const connected = d.auth === 'none' || mine.length > 0;
        const method = d.local ? 'local' : d.auth === 'none' ? 'none' : 'api_key';
        return {
          providerId: d.id,
          name: d.name,
          connected,
          method,
          credentialSource: mine[0]?.source ?? null,
          hint: mine[0]?.label ?? null,
          models,
          health: health?.state ?? 'unknown',
          lastVerifiedAt: app.providers.verifiedAt(d.id) ?? null,
          grants:
            method === 'local'
              ? 'Runs on this machine. Nothing leaves it and nothing is billed.'
              : method === 'none'
                ? 'Open endpoint: no credential is needed.'
                : 'API access billed to this key. This is not a consumer subscription.',
          detail: connected ? null : `Set ${d.envKeys[0] ?? 'a credential'} or add one under Credentials.`,
        };
      }),
    };
  });
}
