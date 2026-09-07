import type { FastifyInstance } from 'fastify';
import {
  MeridianError,
  isFree,
  isZeroCost,
  newId,
  type AIRequest,
  type InferencePool,
  type PoolMember,
  type Reservation,
  type RoutingMode,
  type TrustLevel,
} from '@meridian/shared';
import {
  BENCHMARK_SUITE,
  bestForLabel,
  freeRadar,
  groupRoutes,
  multiRouteGroups,
  recommendationScore,
  runBenchmark,
  stars,
  summarise,
  type RouteContext,
} from '@meridian/model-sdk';
import { mayUseCredential, requireAdmin, requireCredentialOwner, requireScope } from './authz.js';
import type { App } from '../services/app.js';
import { intParam } from './shared.js';

/**
 * Provider, model, pool, credential and usage administration.
 *
 * Everything here is operator-facing. The one invariant that runs through all
 * of it: a credential's plaintext never appears in a response, only its hint.
 */
export async function registerAdminRoutes(server: FastifyInstance, app: App): Promise<void> {
  /* ---------------- Providers ---------------- */

  server.get('/api/providers', async () => ({
    providers: app.providers.list().map((d) => {
      const health = app.health.get(d.id);
      const models = app.models.all().filter((m) => m.providerId === d.id);
      const free = models.filter((m) => isFree(m.pricing)).length;
      return {
        ...d,
        supportState: app.providers.supportState(d.id),
        health,
        cooldownSec: app.health.cooldownRemaining(d.id),
        credentials: app.store.listCredentials().filter((c) => c.providerId === d.id).length,
        models: models.length,
        freeModels: free,
        paidModels: models.length - free,
        verifiedCapabilities: app.providers.verifiedCapabilities(d.id),
        // Access and economics from the synced dataset, when it covers this
        // provider. Null is a real answer: most locally-configured endpoints
        // are not in any public catalog.
        intelligence: app.catalogSync.for(d.id),
      };
    }),
  }));

  /* ---------------- Synced catalog ---------------- */

  /**
   * What the provider catalog knows, where it came from, and how old it is.
   *
   * The freshness fields are not decoration: an operator choosing a provider on
   * the strength of "free tier, no card" deserves to know that claim was last
   * checked months ago and could not be refreshed today.
   */
  server.get('/api/catalog/status', async () => ({ status: app.catalogSync.status() }));

  /**
   * Force a refresh from the upstream dataset.
   *
   * Admin-only and explicitly triggered: it reaches out to a third-party host,
   * and it can change which providers this instance will route to.
   */
  server.post('/api/catalog/sync', async (req) => {
    requireAdmin(req);
    const status = await app.catalogSync.runOnce();
    // A sync can register providers, which changes what discovery is allowed to
    // ask. Tell the clients so the model menus refresh themselves.
    app.events.publish({
      type: 'discovery',
      providerId: status.source,
      added: status.registered,
      removed: 0,
      total: app.providers.list().length,
    });
    return { status };
  });

  /**
   * The access picture for every provider the dataset covers.
   *
   * `free=true` filters to access kinds that cost nothing at the moment of the
   * call — which deliberately excludes trial credit, because a finite balance
   * is cheap, not free.
   */
  server.get<{ Querystring: { free?: string; noCard?: string; commercial?: string } }>(
    '/api/catalog/intelligence',
    async (req) => {
      let rows = app.catalogSync.all();
      if (req.query.free === 'true') rows = rows.filter((r) => isZeroCost(r.freeAccess));
      // 'no' only — an unconfirmed card requirement must not pass a "no card"
      // filter, or the filter becomes a promise Meridian cannot keep.
      if (req.query.noCard === 'true') rows = rows.filter((r) => r.requirements.card === 'no');
      if (req.query.commercial === 'true') rows = rows.filter((r) => r.commercialUse === 'yes');
      return { providers: rows, total: rows.length };
    },
  );

  /* ---------------- Routes ---------------- */

  /**
   * The same model, grouped by every way of reaching it.
   *
   * This is what makes "cheapest" a routing decision rather than a property of
   * a model name: one group, several providers, each with its own price, speed
   * and free allowance.
   */
  server.get<{ Querystring: { multiOnly?: string; limit?: string; q?: string } }>(
    '/api/routes',
    async (req) => {
      let groups = groupRoutes(app.models.all(), routeContext(app));
      if (req.query.multiOnly === 'true') groups = multiRouteGroups(groups);
      if (req.query.q) {
        const needle = req.query.q.toLowerCase();
        groups = groups.filter(
          (g) => g.key.includes(needle) || g.displayName.toLowerCase().includes(needle),
        );
      }
      const limit = intParam(req.query.limit, 100, 500);
      return { groups: groups.slice(0, limit), total: groups.length };
    },
  );

  /** Every route for one model group. */
  server.get<{ Params: { key: string } }>('/api/routes/:key', async (req) => {
    const group = groupRoutes(app.models.all(), routeContext(app)).find((g) => g.key === req.params.key);
    if (!group) throw new MeridianError('invalid_request', `No route group "${req.params.key}"`);
    return { group };
  });

  /**
   * The best models available for nothing, right now.
   *
   * `includeUnconfigured` shows what would become available with a key, which
   * is the honest way to answer "what am I missing" without pretending those
   * routes are usable today — each entry says so in its note.
   */
  server.get<{ Querystring: { limit?: string; includeUnconfigured?: string; task?: string } }>(
    '/api/radar/free',
    async (req) => {
      const groups = groupRoutes(app.models.all(), routeContext(app));
      // Chat is the honest default: an unspecified task is a general one.
      const taskType = (req.query.task as AIRequest['taskType']) ?? 'chat';
      const entries = freeRadar(groups, {
        limit: intParam(req.query.limit, 20, 100),
        includeUnconfigured: req.query.includeUnconfigured === 'true',
        quality: (modelId) => {
          const v = app.models.view(modelId);
          return recommendationScore(v?.scores ?? null, v?.performance ?? null, taskType);
        },
      });
      return {
        entries,
        // Said plainly rather than implied: an empty radar with no credentials
        // is a configuration state, not an absence of free models.
        configuredProviders: app.providers.list().filter((d) => app.credentials.hasAny(d.id)).length,
      };
    },
  );

  /** What changed at the last sync, most consequential first. */
  server.get('/api/catalog/changes', async () => {
    const { lastChanges } = app.catalogSync.status();
    return {
      changes: [...lastChanges].sort((a, b) => Number(b.significant) - Number(a.significant)),
    };
  });

  server.patch<{ Params: { id: string }; Body: { trust?: TrustLevel; baseUrl?: string; enabled?: boolean; dataUse?: unknown } }>(
    '/api/providers/:id',
    async (req) => {
      // Trust level and base URL decide where every user's requests go and how
      // sensitive a workspace may be for a provider. Instance-wide, so admin.
      requireAdmin(req);
      const descriptor = app.providers.descriptor(req.params.id);
      if (!descriptor) throw new MeridianError('invalid_request', `No provider "${req.params.id}"`);
      const body = req.body ?? {};

      // A PATCH is a merge. Writing `body.field ?? null` stored a NULL over
      // every override the request did not mention, so toggling `enabled`
      // silently erased an operator's trust and URL customisations.
      const existing = app.store.listProviderOverrides().find((o) => o.id === req.params.id);
      app.store.saveProviderOverride(req.params.id, {
        trust: body.trust ?? existing?.trust ?? null,
        baseUrl: body.baseUrl ?? existing?.baseUrl ?? null,
        enabled: body.enabled ?? existing?.enabled,
        dataUse: body.dataUse ?? existing?.dataUse,
      });
      // The registry holds the effective descriptor, so an override has to be
      // applied there too or it would not take effect until a restart.
      app.providers.registerProvider({
        ...descriptor,
        trust: body.trust ?? descriptor.trust,
        baseUrl: body.baseUrl ?? descriptor.baseUrl,
        dataUse: (body.dataUse as typeof descriptor.dataUse) ?? descriptor.dataUse,
      });
      if (body.enabled !== undefined) app.providers.setEnabled(req.params.id, body.enabled);
      app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'provider.update', target: req.params.id, details: { ...body }, ip: req.ip });
      return { ok: true, provider: app.providers.descriptor(req.params.id) };
    },
  );

  /** Verify a provider by making a real call, then record what it can do. */
  server.post<{ Params: { id: string } }>('/api/providers/:id/verify', async (req) => {
    const adapter = app.providers.get(req.params.id);
    const descriptor = app.providers.descriptor(req.params.id);
    if (!adapter || !descriptor) throw new MeridianError('invalid_request', `No adapter for "${req.params.id}"`);

    const resolution = app.credentials.resolve({ providerId: req.params.id }, descriptor.auth !== 'none');
    if (!resolution.credential && descriptor.auth !== 'none') {
      return { ok: false, supportState: app.providers.supportState(req.params.id), detail: resolution.reason };
    }
    if (!adapter.healthCheck) {
      return { ok: false, supportState: app.providers.supportState(req.params.id), detail: 'This adapter has no health check.' };
    }

    const result = await adapter.healthCheck({
      secret: resolution.credential?.secret ?? null,
      logger: app.logger,
      requestId: req.requestId,
      timeoutMs: 20_000,
    });
    app.health.recordProbe(req.params.id, result.ok, result.latencyMs, result.detail);
    if (result.ok) {
      app.providers.setVerified(req.params.id, adapter.capabilities());
      app.store.saveProviderOverride(req.params.id, { verifiedAt: Date.now() });
    }
    return { ok: result.ok, latencyMs: result.latencyMs, detail: result.detail, supportState: app.providers.supportState(req.params.id) };
  });

  server.post<{ Params: { id: string } }>('/api/providers/:id/reset-health', async (req) => {
    // Clearing a breaker sends every user's traffic back at a provider that was
    // failing, so it is not one user's call to make.
    requireAdmin(req);
    return { health: app.health.reset(req.params.id) };
  });

  server.post('/api/providers/discover', async () => {
    const result = await app.discovery.runOnce();
    app.refreshCredentialState();
    return { ...result, models: app.models.size() };
  });

  /* ---------------- Credentials ---------------- */

  server.get('/api/credentials', async (req) => {
    requireScope(req, 'credentials');
    // A shared instance must not let one user enumerate another's keys, even
    // without their secrets: the provider, the label and the id are enough to
    // target them.
    const workspaces = app.workspaceIdsFor(req.auth.userId);
    return {
      credentials: app.store.listCredentials().filter((c) => mayUseCredential(req, c, workspaces)),
      pools: app.store.listCredentialPools(),
    };
  });

  server.post<{
    Body: { providerId?: string; secret?: string; label?: string; scope?: string; workspaceId?: string; poolId?: string; priority?: number; maxConcurrency?: number };
  }>('/api/credentials', async (req) => {
    requireScope(req, 'credentials');
    const body = req.body ?? {};
    if (!body.providerId) throw new MeridianError('invalid_request', '"providerId" is required');
    if (!app.providers.descriptor(body.providerId)) throw new MeridianError('invalid_request', `No provider "${body.providerId}"`);
    const descriptor = app.providers.descriptor(body.providerId)!;
    if (descriptor.auth !== 'none' && !body.secret) throw new MeridianError('invalid_request', `${descriptor.name} requires a secret`);

    const scope = (body.scope as 'user' | 'workspace' | 'admin' | 'system') ?? 'user';
    // A user may add their own key, and a key for a workspace they can reach.
    // Anything the whole instance would draw on is the operator's decision.
    if (scope === 'admin' || scope === 'system') requireAdmin(req);
    if (scope === 'workspace') {
      const reachable = app.workspaceIdsFor(req.auth.userId);
      if (!body.workspaceId || (req.auth.role !== 'admin' && !reachable.has(body.workspaceId))) {
        throw new MeridianError('invalid_request', 'A workspace-scoped credential needs a workspace you can reach');
      }
    }

    const record = app.store.addCredential({
      providerId: body.providerId,
      secret: body.secret ?? null,
      // A credential entered through the UI is the user's own by default.
      scope,
      source: 'user-entered',
      label: body.label ?? `${descriptor.name} key`,
      userId: req.auth.userId,
      workspaceId: body.workspaceId ?? null,
      poolId: body.poolId ?? null,
      priority: body.priority,
      maxConcurrency: body.maxConcurrency ?? null,
    });
    app.refreshCredentialState();
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'credential.create',
      target: record.id,
      // The secret is deliberately absent: an audit log that records secrets is
      // a second place they can leak from.
      details: { providerId: body.providerId, scope: record.scope, label: record.label },
      ip: req.ip,
    });
    return { credential: record };
  });

  server.patch<{ Params: { id: string }; Body: { secret?: string; enabled?: boolean } }>('/api/credentials/:id', async (req) => {
    requireCredentialOwner(req, app.store.getCredential(req.params.id), app.workspaceIdsFor(req.auth.userId));
    const body = req.body ?? {};
    if (body.secret) app.store.updateCredentialSecret(req.params.id, body.secret);
    if (body.enabled !== undefined) app.store.setCredentialEnabled(req.params.id, body.enabled);
    app.refreshCredentialState();
    app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'credential.update', target: req.params.id, details: { rotated: Boolean(body.secret), enabled: body.enabled }, ip: req.ip });
    return { ok: true };
  });

  server.delete<{ Params: { id: string } }>('/api/credentials/:id', async (req) => {
    requireCredentialOwner(req, app.store.getCredential(req.params.id), app.workspaceIdsFor(req.auth.userId));
    const removed = app.store.deleteCredential(req.params.id);
    app.refreshCredentialState();
    app.store.audit({ actor: req.auth.userId ?? 'anonymous', action: 'credential.delete', target: req.params.id, details: {}, ip: req.ip });
    return { removed };
  });

  server.post<{ Body: { providerId?: string; name?: string; strategy?: 'priority' | 'round-robin' | 'least-used' | 'health' } }>(
    '/api/credentials/pools',
    async (req) => {
      // A credential pool decides which keys the whole instance rotates through.
      requireAdmin(req);
      const body = req.body ?? {};
      if (!body.providerId || !body.name) throw new MeridianError('invalid_request', '"providerId" and "name" are required');
      return { pool: app.store.addCredentialPool(body.providerId, body.name, body.strategy ?? 'priority') };
    },
  );

  /* ---------------- Models ---------------- */

  server.get<{ Querystring: { modality?: string; search?: string; free?: string; provider?: string; limit?: string } }>('/api/models', async (req) => {
    const q = req.query ?? {};
    const views = app.models.views({
      modality: q.modality as never,
      search: q.search,
      freeOnly: q.free === 'true',
      providerIds: q.provider ? [q.provider] : undefined,
    });

    return {
      models: views.slice(0, intParam(q.limit, 500, 2000)).map((v) => ({
        ...v.model,
        free: isFree(v.model.pricing),
        scores: v.scores,
        performance: v.performance,
        status: v.status,
        supportState: app.providers.supportState(v.model.providerId),
        recommendation: {
          coding: stars(v.scores?.coding ?? null),
          reasoning: stars(v.scores?.reasoning ?? null),
          general: stars(v.scores?.general ?? null),
          bestFor: bestForLabel(v.scores),
          score: recommendationScore(v.scores, v.performance, 'chat'),
        },
      })),
      total: views.length,
    };
  });

  // A model id contains both ':' and '/', so it travels as a query parameter:
  // a path segment would have to be double-encoded to survive routing.
  server.get<{ Querystring: { id?: string } }>('/api/models/detail', async (req) => {
    const id = req.query?.id ?? '';
    const view = app.models.view(id);
    if (!view) throw new MeridianError('model_unavailable', `No model "${id}"`);
    return {
      ...view,
      free: isFree(view.model.pricing),
      benchmarks: app.store.listBenchmarks(view.model.id, 50),
      provider: app.providers.descriptor(view.model.providerId),
    };
  });

  /** Run the benchmark suite against a model and fold the result into its scores. */
  server.post<{ Body: { modelId?: string } }>('/api/models/benchmark', async (req) => {
    const modelId = req.body?.modelId ?? '';
    const model = app.models.get(modelId);
    if (!model) throw new MeridianError('model_unavailable', `No model "${modelId}"`);

    const results = await runBenchmark(model, async (completion) => {
      const res = await app.executor.chat(
        {
          modality: 'text',
          taskType: 'chat',
          model: model.id,
          provider: model.providerId,
          userId: req.auth.userId,
          // Benchmarking a paid model still spends the caller's money, so the
          // caller's own paid permission decides — deriving it from the model's
          // pricing turned "this model costs money" into "you agreed to pay".
          allowPaid: app.preferencesFor(req.auth.userId).allowPaid,
        },
        completion,
        { requestId: req.requestId, retryBudget: 1 },
      );
      return res.value;
    });

    app.store.addBenchmarkResults(results.map((r) => ({ ...r, dimension: r.dimension })));
    const summary = summarise(results);
    if (summary) {
      const scores = {
        modelId: model.id,
        coding: summary.coding,
        reasoning: summary.reasoning,
        general: summary.general,
        toolUse: summary.toolUse,
        vision: app.models.getScores(model.id)?.vision ?? null,
        stability: summary.uptime,
        samples: (app.models.getScores(model.id)?.samples ?? 0) + summary.cases,
        updatedAt: Date.now(),
      };
      app.models.setScores(scores);
      app.store.setModelScores(scores);

      const perf = {
        modelId: model.id,
        ttftMs: summary.ttftMs,
        latencyMs: summary.latencyMs,
        p95LatencyMs: summary.p95LatencyMs,
        jitterMs: summary.jitterMs,
        tokensPerSecond: summary.tokensPerSecond,
        uptime: summary.uptime,
        samples: (app.models.getPerformance(model.id)?.samples ?? 0) + summary.cases,
        updatedAt: Date.now(),
      };
      app.models.setPerformance(perf);
      app.store.setModelPerformance(perf);
    }
    return { results, summary, cases: BENCHMARK_SUITE.length };
  });

  /**
   * Run the same prompt against several models.
   *
   * Models are run concurrently and each failure is captured as a result rather
   * than aborting the comparison — a model being unavailable is exactly the
   * kind of thing a comparison is for.
   */
  server.post<{ Body: { models?: string[]; prompt?: string; taskType?: AIRequest['taskType']; maxTokens?: number } }>(
    '/api/models/compare',
    async (req) => {
      const body = req.body ?? {};
      if (!body.models?.length || !body.prompt) throw new MeridianError('invalid_request', '"models" and "prompt" are required');
      if (body.models.length > 6) throw new MeridianError('invalid_request', 'Compare at most six models at a time');

      const started = Date.now();
      const results = await Promise.all(
        body.models.map(async (modelId) => {
          const model = app.models.get(modelId);
          if (!model) return { modelId, error: 'Model not found', output: null, latencyMs: 0, cost: 0, usage: null, provider: null };
          try {
            const res = await app.executor.chat(
              {
                modality: 'text',
                taskType: body.taskType ?? 'chat',
                model: model.id,
                provider: model.providerId,
                userId: req.auth.userId,
                // Benchmarking a paid model still spends the caller's money, so the
          // caller's own paid permission decides — deriving it from the model's
          // pricing turned "this model costs money" into "you agreed to pay".
          allowPaid: app.preferencesFor(req.auth.userId).allowPaid,
              },
              { messages: [{ role: 'user', content: body.prompt! }], maxTokens: body.maxTokens ?? 1024, temperature: 0.2 },
              { requestId: req.requestId, retryBudget: 1 },
            );
            return {
              modelId,
              provider: res.providerId,
              output: res.value.content,
              latencyMs: res.value.latencyMs,
              cost: res.value.usage.cost,
              usage: res.value.usage,
              toolCalls: res.value.toolCalls.length,
              error: null,
            };
          } catch (e) {
            return { modelId, provider: model.providerId, output: null, latencyMs: 0, cost: 0, usage: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { results, totalMs: Date.now() - started };
    },
  );

  /* ---------------- Routing ---------------- */

  /** Dry-run the router: the full ranking, with nothing executed. */
  server.post<{ Body: Partial<AIRequest> }>('/api/routing/preview', async (req) => {
    const body = req.body ?? {};
    const request: AIRequest = {
      modality: body.modality ?? 'text',
      taskType: body.taskType ?? 'chat',
      prompt: body.prompt,
      messages: body.messages,
      model: body.model ?? null,
      provider: body.provider ?? null,
      pool: body.pool ?? null,
      mode: body.mode,
      privacyMode: body.privacyMode,
      freeOnly: body.freeOnly,
      localOnly: body.localOnly,
      allowPaid: body.allowPaid,
      budget: body.budget ?? null,
      contextLength: body.contextLength ?? null,
      toolsRequired: body.toolsRequired,
      reasoningRequired: body.reasoningRequired,
      visionRequired: body.visionRequired,
      sensitive: body.sensitive,
      requiredCapabilities: body.requiredCapabilities,
      userId: req.auth.userId,
      workspaceId: body.workspaceId ?? null,
    };

    const preview = app.router.preview(request);
    let decision = null;
    try {
      decision = app.router.route(request);
    } catch (e) {
      // A request with no viable candidate is a legitimate outcome to display,
      // not a server error: the rejection list is the answer.
      decision = null;
      if (!(e instanceof MeridianError)) throw e;
    }
    return {
      decision,
      candidates: preview.candidates.slice(0, 25).map((c) => ({ ...c, model: app.models.get(c.modelId) })),
      rejected: preview.rejected.slice(0, 40),
    };
  });

  /* ---------------- Pools ---------------- */

  server.get('/api/pools', async () => ({
    pools: app.pools.list().map((p) => ({
      ...p,
      usage: app.pools.usageOf(p.id),
      concurrencyLimit: app.pools.concurrencyLimit(p.id),
      budgetLimit: app.pools.budgetLimit(p.id),
      activeReservation: app.pools.activeReservation(p.id),
      fallbackChain: app.pools.fallbackChain(p.id),
    })),
    reservations: app.pools.listReservations(),
  }));

  server.post<{ Body: Partial<InferencePool> }>('/api/pools', async (req) => {
    // A pool decides which models the whole instance may draw on.
    requireAdmin(req);
    const body = req.body ?? {};
    if (!body.name) throw new MeridianError('invalid_request', '"name" is required');
    const pool: InferencePool = {
      id: body.id ?? newId('pool'),
      name: body.name,
      description: body.description ?? null,
      strategy: (body.strategy as RoutingMode) ?? 'BALANCED',
      members: body.members ?? [],
      fallbackPoolId: body.fallbackPoolId ?? null,
      maxConcurrency: body.maxConcurrency ?? null,
      dailyBudget: body.dailyBudget ?? null,
      builtin: false,
      enabled: body.enabled ?? true,
      createdAt: Date.now(),
    };
    app.pools.upsert(pool);
    app.store.savePool(pool);
    return { pool };
  });

  server.patch<{ Params: { id: string }; Body: Partial<InferencePool> & { members?: PoolMember[] } }>('/api/pools/:id', async (req) => {
    requireAdmin(req);
    const existing = app.pools.get(req.params.id);
    if (!existing) throw new MeridianError('invalid_request', `No pool "${req.params.id}"`);
    const next: InferencePool = {
      ...existing,
      ...req.body,
      id: existing.id,
      // A built-in pool stays built-in; the flag governs deletability.
      builtin: existing.builtin,
      createdAt: existing.createdAt,
    };
    app.pools.upsert(next);
    app.store.savePool(next);
    return { pool: next };
  });

  server.delete<{ Params: { id: string } }>('/api/pools/:id', async (req) => {
    requireAdmin(req);
    const removed = app.pools.remove(req.params.id) && app.store.deletePool(req.params.id);
    if (!removed) throw new MeridianError('invalid_request', 'Built-in pools cannot be deleted. Disable it instead.');
    return { removed };
  });

  /* ---------------- Reservations ---------------- */

  server.post<{ Body: Partial<Reservation> & { hours?: number } }>('/api/reservations', async (req) => {
    const body = req.body ?? {};
    if (!body.poolId || !app.pools.get(body.poolId)) throw new MeridianError('invalid_request', 'A valid "poolId" is required');
    const startAt = body.startAt ?? Date.now();
    const endAt = body.endAt ?? startAt + (body.hours ?? 2) * 3_600_000;
    if (endAt <= startAt) throw new MeridianError('invalid_request', 'The reservation must end after it starts');

    const reservation: Reservation = {
      id: newId('resv'),
      poolId: body.poolId,
      label: body.label ?? `${(endAt - startAt) / 3_600_000}h reservation`,
      startAt,
      endAt,
      maxConcurrency: body.maxConcurrency ?? 4,
      budget: body.budget ?? null,
      fallbackPoolId: body.fallbackPoolId ?? app.pools.get(body.poolId)?.fallbackPoolId ?? null,
      models: body.models ?? [],
      status: startAt <= Date.now() ? 'active' : 'scheduled',
      used: 0,
      spend: 0,
      createdAt: Date.now(),
    };
    app.pools.addReservation(reservation);
    app.store.saveReservation(reservation);
    return { reservation };
  });

  server.delete<{ Params: { id: string } }>('/api/reservations/:id', async (req) => {
    app.pools.cancelReservation(req.params.id);
    const removed = app.store.deleteReservation(req.params.id);
    return { removed };
  });

  /* ---------------- Usage ---------------- */

  server.get<{ Querystring: { days?: string; limit?: string } }>('/api/usage', async (req) => {
    const days = intParam(req.query?.days, 30, 365);
    const since = Date.now() - days * 86_400_000;
    // Usage rows name models, workspaces, tasks and spend. An administrator sees
    // the instance; everyone else sees their own.
    const scope = req.auth.role === 'admin' ? undefined : req.auth.userId;
    return {
      since,
      days,
      summary: app.store.usageSummary(since, scope),
      recent: app.store.listUsage({ since, limit: intParam(req.query?.limit, 100, 1000), userId: scope }),
    };
  });

  server.get('/api/health', async () => ({
    providers: app.providers.list().map((d) => ({
      providerId: d.id,
      name: d.name,
      supportState: app.providers.supportState(d.id),
      health: app.health.get(d.id),
      cooldownSec: app.health.cooldownRemaining(d.id),
    })),
  }));
}

/**
 * Everything the route grouper needs to describe one option, read from the
 * live app rather than from a snapshot, so a route's health and configuration
 * state are current at the moment it is asked for.
 */
function routeContext(app: App): RouteContext {
  return {
    view: (modelId) => app.models.view(modelId),
    health: (providerId) => app.health.get(providerId),
    supportState: (providerId) => app.providers.supportState(providerId),
    configured: (providerId) => {
      const d = app.providers.descriptor(providerId);
      // An endpoint that needs no auth is usable without a credential.
      return d ? d.auth === 'none' || app.credentials.hasAny(providerId) : false;
    },
    freeAccess: (providerId) => app.catalogSync.for(providerId)?.freeAccess ?? null,
    local: (providerId) => app.providers.descriptor(providerId)?.local ?? false,
  };
}
