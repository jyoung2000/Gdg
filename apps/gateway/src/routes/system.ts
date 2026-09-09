import type { FastifyInstance } from 'fastify';
import { DEFAULT_PORT, MODE_DESCRIPTION_KEYS } from './shared.js';
import { MODE_DESCRIPTION, PRIVACY_DESCRIPTION, MODE_WEIGHTS } from '@meridian/routing-sdk';
import { AGENT_DEFINITIONS, AGENT_ROLES_ORDER } from '@meridian/agent-sdk';
import { CAPABILITIES, MERIDIAN_VERSION, MODALITIES, PRICING_KINDS, PRIVACY_MODES, ROUTING_MODES, TASK_TYPES, TRUST_LEVELS } from '@meridian/shared';
import { requireAdmin } from './authz.js';
import type { App } from '../services/app.js';

/**
 * System information and vocabulary.
 *
 * The web client reads its entire vocabulary — modes, modalities, capabilities,
 * pricing kinds, agent roles — from here rather than duplicating the constants.
 * One definition means the UI cannot drift from what the router actually
 * accepts.
 */
export async function registerSystemRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/api/system/info', async () => {
    const providers = app.providers.list();
    const supported = providers.filter((p) => app.providers.supportState(p.id) === 'supported');
    const configured = providers.filter((p) => {
      const s = app.providers.supportState(p.id);
      return s === 'supported' || s === 'experimental';
    });

    return {
      name: 'Meridian',
      description: 'Universal AI Gateway',
      version: MERIDIAN_VERSION,
      port: app.config.port,
      defaultPort: DEFAULT_PORT,
      authRequired: app.config.authRequired,
      allowPaid: app.config.allowPaid,
      defaultRoutingMode: app.config.defaultRoutingMode,
      defaultPrivacyMode: app.config.defaultPrivacyMode,
      sandbox: {
        kind: app.sandbox.kind,
        isolation: app.sandbox.isolationNote,
        isolationSummary: app.sandbox.isolationSummary,
        degradedReason: app.sandboxDegradedReason,
        networkEnabled: app.config.sandboxNetwork,
      },
      counts: {
        providers: providers.length,
        providersConfigured: configured.length,
        providersVerified: supported.length,
        models: app.models.size(),
        pools: app.pools.list().length,
        workspaces: app.store.listWorkspaces().length,
      },
      warnings: app.warnings,
      endpoints: {
        openai: `/v1`,
        anthropic: `/anthropic/v1`,
        events: `/api/events`,
      },
    };
  });

  server.get('/api/system/health', async () => ({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    models: app.models.size(),
    providers: app.providers.usable().length,
    subscribers: app.events.subscriberCount,
  }));

  /**
   * Readiness, for a container platform's readiness probe.
   *
   * Answers 503 rather than 200 when the instance cannot serve a request, so an
   * orchestrator holds traffic back instead of routing it into an error. The
   * body lists every check either way, because a probe that only flips a
   * boolean makes the operator go digging.
   */
  server.get('/api/system/ready', async (_req, reply) => {
    const result = app.readiness();
    return reply.code(result.ready ? 200 : 503).send({
      ...result,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  /** What a fresh install still needs before it is useful. */
  server.get('/api/onboarding', async () => ({
    ...app.onboarding(),
    warnings: app.warnings,
  }));

  /** Every enum the UI renders, with its human copy. */
  server.get('/api/system/vocabulary', async () => ({
    routingModes: ROUTING_MODES.map((mode) => ({
      value: mode,
      description: MODE_DESCRIPTION[mode],
      weights: MODE_WEIGHTS[mode],
      primary: MODE_DESCRIPTION_KEYS.includes(mode),
    })),
    privacyModes: PRIVACY_MODES.map((value) => ({ value, description: PRIVACY_DESCRIPTION[value] })),
    modalities: MODALITIES,
    taskTypes: TASK_TYPES,
    capabilities: CAPABILITIES,
    pricingKinds: PRICING_KINDS,
    trustLevels: TRUST_LEVELS,
    agents: AGENT_ROLES_ORDER.map((role) => {
      const a = AGENT_DEFINITIONS[role];
      return {
        role: a.role,
        name: a.name,
        description: a.description,
        taskType: a.taskType,
        preferredMode: a.preferredMode,
        pool: a.pool,
        tools: a.tools,
        maxSteps: a.maxSteps,
      };
    }),
  }));

  /** Gateway API keys. The plaintext is returned exactly once, on creation. */
  // Gateway keys are the instance's own credentials: listing them tells a
  // caller who else has access, and minting one grants it.
  server.get('/api/system/keys', async (req) => {
    requireAdmin(req);
    return { keys: app.store.listApiKeys() };
  });

  server.post<{ Body: { name?: string } }>('/api/system/keys', async (req) => {
    requireAdmin(req);
    const created = app.store.createApiKey(req.auth.userId, req.body?.name ?? 'Untitled key');
    app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'api_key.create', target: created.id, details: { name: req.body?.name }, ip: req.ip });
    return { id: created.id, key: created.key, hint: created.hint, note: 'Copy this key now. It is not recoverable.' };
  });

  server.delete<{ Params: { id: string } }>('/api/system/keys/:id', async (req) => {
    requireAdmin(req);
    const removed = app.store.deleteApiKey(req.params.id);
    app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'api_key.delete', target: req.params.id, details: {}, ip: req.ip });
    return { removed };
  });

  // The audit log records what every user did, which is exactly why it is not
  // readable by every user.
  server.get('/api/system/audit', async (req) => {
    requireAdmin(req);
    return { entries: app.store.listAudit(Number((req.query as { limit?: string }).limit ?? 200)) };
  });

  /* ---- Preferences ------------------------------------------------ */

  server.get('/api/preferences', async (req) => app.preferencesFor(req.auth.userId));

  server.put<{ Body: Record<string, unknown> }>('/api/preferences', async (req) => {
    const current = app.preferencesFor(req.auth.userId);
    const next = { ...current, ...req.body, userId: current.userId, updatedAt: Date.now() };
    app.store.setPreferences(next as typeof current);
    return next;
  });
}
