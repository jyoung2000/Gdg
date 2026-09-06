import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createLogger,
  newId,
  type FallbackEvent,
  type GeneratedAsset,
  type InferencePool,
  type Logger,
  type MeridianConfig,
  type ProviderDescriptor,
  type UsageRecord,
  type UserPreferences,
} from '@meridian/shared';
import { ModelRegistry, applyObservation, applyPerformance, enrich } from '@meridian/model-sdk';
import { ProviderRegistry, createRegistry, discoverEnvCredentials, PROVIDER_CATALOG } from '@meridian/provider-sdk';
import { BUILTIN_POOLS, CredentialResolver, Executor, HealthStore, PoolManager, Router } from '@meridian/routing-sdk';
import { MediaEngine, decodeDataUrl, extensionFor } from '@meridian/media-sdk';
import {
  Orchestrator,
  ParallelRunner,
  Workspace,
  createToolRegistry,
  resolveSandbox,
  type Sandbox,
  type TaskEvent,
  type ToolRegistry,
} from '@meridian/agent-sdk';
import { openDatabase } from '../db/database.js';
import { SecretBox } from '../db/crypto.js';
import { Store, defaultPreferences } from '../db/store.js';
import { Discovery } from './discovery.js';
import { EventBus, type ServerEvent } from './events.js';

export interface Warning {
  level: 'info' | 'warn';
  message: string;
}

interface AppParts {
  config: MeridianConfig;
  logger: Logger;
  store: Store;
  providers: ProviderRegistry;
  models: ModelRegistry;
  health: HealthStore;
  credentials: CredentialResolver;
  pools: PoolManager;
  router: Router;
  executor: Executor;
  media: MediaEngine;
  orchestrator: Orchestrator;
  parallel: ParallelRunner;
  tools: ToolRegistry;
  sandbox: Sandbox;
  sandboxDegradedReason: string | null;
  events: EventBus;
  discovery: Discovery;
  warnings: Warning[];
}

/**
 * The service container.
 *
 * Everything the gateway needs is constructed once, here, and handed to the
 * routes. Wiring in one place is what keeps the dependency graph legible: the
 * router does not know about HTTP, the routes do not know about SQL, and the
 * SDKs know about neither.
 */
export class App {
  readonly config: MeridianConfig;
  readonly logger: Logger;
  readonly store: Store;
  readonly providers: ProviderRegistry;
  readonly models: ModelRegistry;
  readonly health: HealthStore;
  readonly credentials: CredentialResolver;
  readonly pools: PoolManager;
  readonly router: Router;
  readonly executor: Executor;
  readonly media: MediaEngine;
  readonly orchestrator: Orchestrator;
  readonly parallel: ParallelRunner;
  readonly tools: ToolRegistry;
  readonly sandbox: Sandbox;
  readonly sandboxDegradedReason: string | null;
  readonly events: EventBus;
  readonly discovery: Discovery;
  readonly warnings: Warning[];

  /** Live workspaces, keyed by workspace id, so change state survives requests. */
  private readonly workspaces = new Map<string, Workspace>();
  private readonly timers: NodeJS.Timeout[] = [];
  /** Recent latencies per model; p95 and jitter need the distribution. */
  private readonly latencyWindows = new Map<string, number[]>();

  private constructor(parts: AppParts) {
    this.config = parts.config;
    this.logger = parts.logger;
    this.store = parts.store;
    this.providers = parts.providers;
    this.models = parts.models;
    this.health = parts.health;
    this.credentials = parts.credentials;
    this.pools = parts.pools;
    this.router = parts.router;
    this.executor = parts.executor;
    this.media = parts.media;
    this.orchestrator = parts.orchestrator;
    this.parallel = parts.parallel;
    this.tools = parts.tools;
    this.sandbox = parts.sandbox;
    this.sandboxDegradedReason = parts.sandboxDegradedReason;
    this.events = parts.events;
    this.discovery = parts.discovery;
    this.warnings = parts.warnings;
  }

  static async create(config: MeridianConfig): Promise<App> {
    const logger = createLogger({ level: config.logLevel, format: config.logFormat });
    const db = openDatabase(config.databasePath, logger);
    const box = SecretBox.create(db, config.masterKey);
    const store = new Store(db, box);
    const warnings: Warning[] = [];

    if (!box.derivedFromEnv) {
      warnings.push({
        level: 'warn',
        message:
          'MERIDIAN_MASTER_KEY is not set, so credential encryption uses a key generated into the database. That protects a leaked backup but not read access to the live database file. Set MERIDIAN_MASTER_KEY in production.',
      });
    }

    /* ---- Models --------------------------------------------------- */
    const models = new ModelRegistry();
    models.upsertMany(store.listModels());
    for (const s of store.listModelScores()) models.setScores(s);
    for (const p of store.listModelPerformance()) models.setPerformance(p);

    /* ---- Providers ------------------------------------------------ */
    const providers = createRegistry({
      pricingLookup: (providerId, providerModelId) =>
        models.get(`${providerId}:${providerModelId}`)?.pricing ?? null,
    });

    // Operator edits layer over the shipped catalog rather than replacing it,
    // so a catalog update still reaches an instance that customised trust.
    const overrides = new Map(store.listProviderOverrides().map((o) => [o.id, o]));
    for (const d of PROVIDER_CATALOG) {
      const o = overrides.get(d.id);
      if (!o) continue;
      providers.registerProvider({
        ...d,
        trust: (o.trust as ProviderDescriptor['trust']) ?? d.trust,
        baseUrl: o.baseUrl ?? d.baseUrl,
        dataUse: (o.dataUse as ProviderDescriptor['dataUse']) ?? d.dataUse,
      });
    }

    /* ---- Credentials ---------------------------------------------- */
    // Environment credentials are re-registered on every start, so rotating a
    // key is a restart rather than a database edit.
    const existing = store.listCredentials();
    for (const found of discoverEnvCredentials(providers.list())) {
      const already = existing.find((c) => c.providerId === found.providerId && c.source === 'environment');
      if (already) {
        store.updateCredentialSecret(already.id, found.secret);
      } else {
        store.addCredential({
          providerId: found.providerId,
          secret: found.secret,
          scope: 'system',
          source: 'environment',
          label: `${found.envKey} (environment)`,
        });
        logger.info('credential discovered from environment', { providerId: found.providerId, envKey: found.envKey });
      }
    }

    const credentials = new CredentialResolver(store);
    for (const d of providers.list()) providers.setCredentialed(d.id, credentials.hasAny(d.id));

    /* ---- Health --------------------------------------------------- */
    const health = new HealthStore();
    health.load(store.listHealth());
    health.onChange((h) => store.saveHealth(h));

    /* ---- Pools ---------------------------------------------------- */
    const pools = new PoolManager();
    const storedPools = store.listPools();
    if (!storedPools.length) {
      const seeded: InferencePool[] = BUILTIN_POOLS.map((p) => ({ ...p, createdAt: Date.now() }));
      for (const p of seeded) store.savePool(p);
      pools.load(seeded, []);
    } else {
      pools.load(storedPools, store.listReservations());
    }

    /* ---- Routing -------------------------------------------------- */
    const events = new EventBus(logger);
    const preferencesFor = (userId: string | null | undefined): UserPreferences | null =>
      userId ? (store.getPreferences(userId) ?? defaultPreferences(userId)) : null;

    const router = new Router({
      models,
      providers,
      health,
      credentials,
      pools,
      allowPaid: () => config.allowPaid,
      preferencesFor,
    });

    const executor = new Executor({
      router,
      models,
      providers,
      health,
      credentials,
      pools,
      logger,
      recordUsage: (row) => {
        store.recordUsage(row);
        events.publish({ type: 'usage', record: row });
      },
      onFallback: (event: FallbackEvent) => events.publish({ type: 'fallback', event }),
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });

    /* ---- Sandbox, agents, media ----------------------------------- */
    const { sandbox, degraded, reason } = await resolveSandbox(config.sandbox, {
      image: config.sandboxImage,
      memoryMb: config.sandboxMemoryMb,
      cpus: config.sandboxCpus,
      network: config.sandboxNetwork,
      logger,
      workspaceRoot: config.workspaceRoot,
      hostWorkspaceRoot: config.workspaceHostRoot,
    });
    if (degraded && reason) warnings.push({ level: 'warn', message: reason });

    const tools = createToolRegistry({ webAccess: config.sandboxNetwork });

    const media = new MediaEngine({
      executor,
      logger,
      persist: (job) => store.saveGenerationJob(job),
      onUpdate: (job) => events.publish({ type: 'generation', job }),
      storeAsset: createAssetStore(config.assetRoot),
    });
    media.load(store.listGenerationJobs(200));

    const orchestrator = new Orchestrator({
      executor,
      router,
      tools,
      sandbox,
      logger,
      commandTimeoutMs: config.sandboxTimeoutMs,
      persistStep: (step) => store.saveStep(step),
      persistTask: (task) => store.saveTask(task),
      persistToolCall: (record) => store.saveToolCall(record),
      persistCheckpoint: (taskId, stepId, checkpoint) => store.saveCheckpoint(taskId, stepId, checkpoint),
      onEvent: (event: TaskEvent) => events.publish({ type: 'task', event }),
    });

    const parallel = new ParallelRunner(orchestrator);
    const discovery = new Discovery({ providers, models, credentials, health, store, logger, config });

    return new App({
      config,
      logger,
      store,
      providers,
      models,
      health,
      credentials,
      pools,
      router,
      executor,
      media,
      orchestrator,
      parallel,
      tools,
      sandbox,
      sandboxDegradedReason: degraded ? reason : null,
      events,
      discovery,
      warnings,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** When the first discovery pass finished; null until it has. */
  private discoveredAt: number | null = null;

  async start(): Promise<void> {
    await mkdir(resolve(this.config.assetRoot), { recursive: true });
    await mkdir(resolve(this.config.workspaceRoot), { recursive: true });

    // Seed the operator account when the instance is empty: a fresh install
    // needs an identity to attach preferences and credentials to.
    if (this.store.countUsers() === 0) {
      // An empty string is what a Compose file passes for an unset variable, and
      // it is not an address. Treated as absent so the bootstrap account gets a
      // usable identity rather than a blank one.
      const email = this.config.adminEmail?.trim() || 'operator@localhost';
      const user = this.store.createUser(email, 'Operator', 'admin', this.config.adminPassword?.trim() || undefined);
      this.logger.info('bootstrap operator created', { userId: user.id, email });
      if (!this.config.adminPassword) {
        this.warnings.push({
          level: 'info',
          message: `A bootstrap operator account was created as ${email} with no password. Set MERIDIAN_ADMIN_PASSWORD, or leave authentication off for a single-user install.`,
        });
      }
    }

    await this.discovery.runOnce();
    this.discoveredAt = Date.now();

    if (this.config.discoveryIntervalMs > 0) {
      this.every(this.config.discoveryIntervalMs, () => this.discovery.runOnce(), 'discovery');
    }
    if (this.config.healthIntervalMs > 0) {
      this.every(this.config.healthIntervalMs, () => this.discovery.checkHealth(), 'health check');
    }
  }

  /**
   * Readiness, as distinct from liveness.
   *
   * `/api/system/health` answers "is this process alive"; this answers "can it
   * serve a request right now". They differ in exactly the case that matters to
   * a container platform: a gateway that has started but has no reachable model
   * is alive and must not receive traffic. Each check names what is wrong and
   * what to do about it, because a readiness probe that only says `false` sends
   * the operator to the logs.
   */
  readiness(): { ready: boolean; checks: { name: string; ok: boolean; detail: string }[] } {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    let dbOk = false;
    let dbDetail = '';
    try {
      // A real read against the schema, not a ping: an unreadable or unmigrated
      // database is the failure this check exists to catch.
      const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
      dbOk = row.n > 0;
      dbDetail = dbOk ? `${row.n} migrations applied` : 'no migrations recorded';
    } catch (e) {
      dbDetail = e instanceof Error ? e.message : String(e);
    }
    checks.push({ name: 'database', ok: dbOk, detail: dbDetail });

    checks.push({
      name: 'discovery',
      ok: this.discoveredAt !== null,
      detail:
        this.discoveredAt === null
          ? 'the first discovery pass has not finished yet'
          : `last completed ${Math.round((Date.now() - this.discoveredAt) / 1000)}s ago`,
    });

    const usable = this.providers.usable().length;
    const models = this.models.size();
    checks.push({
      name: 'models',
      ok: models > 0,
      detail:
        models > 0
          ? `${models} model(s) across ${usable} usable provider(s)`
          : 'no models are available — add a provider credential or start a local inference server',
    });

    return { ready: checks.every((c) => c.ok), checks };
  }

  /**
   * What a fresh install still needs, and what it already has.
   *
   * Deliberately derived from live state rather than a stored "onboarded" flag:
   * an instance whose only provider credential is later removed is back to
   * needing one, and a flag would say otherwise.
   */
  onboarding(): {
    complete: boolean;
    steps: { id: string; title: string; done: boolean; detail: string; docs: string | null }[];
  } {
    const providers = this.providers.list();
    const credentialed = providers.filter((p) => p.auth === 'none' || this.credentials.hasAny(p.id));
    const local = providers.filter((p) => p.local && this.models.all().some((m) => m.providerId === p.id));
    const models = this.models.size();
    const workspaces = this.store.listWorkspaces().length;

    const steps = [
      {
        id: 'inference',
        title: 'Connect somewhere to run models',
        done: models > 0,
        detail:
          models > 0
            ? `${models} model(s) available from ${credentialed.length} provider(s)${local.length ? `, including ${local.length} running locally` : ''}`
            : 'Set a provider API key in the environment, add one under Credentials, or start a local server such as Ollama on port 11434',
        docs: '/docs/CONFIGURATION.md',
      },
      {
        id: 'privacy',
        title: 'Choose how much may leave this machine',
        done: true,
        detail: `Currently ${this.config.defaultPrivacyMode}. Change it in Settings, or with MERIDIAN_PRIVACY_MODE.`,
        docs: '/docs/SECURITY.md',
      },
      {
        id: 'spending',
        title: 'Decide whether Meridian may spend money',
        done: true,
        detail: this.config.allowPaid
          ? 'Paid routing is enabled. Per-task budgets still apply.'
          : 'Paid routing is off, so only free and local models are eligible. Set MERIDIAN_ALLOW_PAID=true to change that.',
        docs: '/docs/ROUTING.md',
      },
      {
        id: 'sandbox',
        title: 'Isolate commands the agents run',
        done: this.sandbox.kind === 'docker',
        detail:
          this.sandbox.kind === 'docker'
            ? 'Commands run in a Docker container with no network and a read-only root.'
            : `Commands run with ${this.sandbox.isolationNote}${this.sandboxDegradedReason ? ` — ${this.sandboxDegradedReason}` : ''}`,
        docs: '/docs/SECURITY.md',
      },
      {
        id: 'workspace',
        title: 'Open a workspace to work in',
        done: workspaces > 0,
        detail: workspaces > 0 ? `${workspaces} workspace(s)` : 'Create one from the Workspaces screen, or clone a repository into it',
        docs: '/docs/AGENTS.md',
      },
    ];

    // Only the steps that genuinely block use decide completeness; the ones that
    // merely record a choice are always "done" and must not gate the banner.
    return { complete: steps.every((s) => s.done || s.id === 'sandbox'), steps };
  }

  private every(ms: number, fn: () => Promise<unknown>, label: string): void {
    const t = setInterval(() => {
      void fn().catch((e: unknown) => this.logger.warn(`${label} failed`, { errorCode: e instanceof Error ? e.message : String(e) }));
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.events.close();
    this.store.db.close();
  }

  /* ---------------------------------------------------------------- */
  /* Helpers used by the routes                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Which workspaces this caller may reach.
   *
   * Their own, plus every workspace with no owner. Unowned workspaces are the
   * ones that existed before ownership did, and on a single-user install that is
   * all of them — so this keeps that install working exactly as it did while
   * giving a shared install a real boundary.
   */
  workspaceIdsFor(userId: string | null): Set<string> {
    const ids = new Set<string>();
    for (const w of this.store.listWorkspaces()) {
      if (w.userId == null || (userId != null && w.userId === userId)) ids.add(w.id);
    }
    return ids;
  }

  /** The live Workspace for a stored record, created on first use. */
  workspaceFor(workspaceId: string): Workspace | null {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;
    const record = this.store.getWorkspace(workspaceId);
    if (!record) return null;
    const ws = new Workspace(record.path);
    this.workspaces.set(workspaceId, ws);
    return ws;
  }

  forgetWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }

  preferencesFor(userId: string | null): UserPreferences {
    if (!userId) return defaultPreferences('anonymous');
    return this.store.getPreferences(userId) ?? defaultPreferences(userId);
  }

  /**
   * Fold a completed call into the model's learned scores.
   *
   * Only telemetry feeds this — success, latency, whether tests passed, whether
   * tool calls parsed, and explicit user feedback. The content of the request is
   * never part of what is learned.
   */
  recordOutcome(
    row: UsageRecord,
    extra: { testsPassed?: boolean | null; toolCallsValid?: boolean | null; userFeedback?: 'positive' | 'negative' | null } = {},
  ): void {
    const nextScores = applyObservation(this.models.getScores(row.modelId), {
      modelId: row.modelId,
      taskType: row.taskType,
      success: row.success,
      latencyMs: row.latencyMs,
      ttftMs: row.ttftMs,
      outputTokens: row.completionTokens,
      testsPassed: extra.testsPassed ?? null,
      toolCallsValid: extra.toolCallsValid ?? null,
      userFeedback: extra.userFeedback ?? null,
      at: row.at,
    });
    this.models.setScores(nextScores);
    this.store.setModelScores(nextScores);

    const window = [...(this.latencyWindows.get(row.modelId) ?? []), row.latencyMs].slice(-100);
    this.latencyWindows.set(row.modelId, window);
    const nextPerf = applyPerformance(
      this.models.getPerformance(row.modelId),
      {
        modelId: row.modelId,
        latencyMs: row.latencyMs,
        ttftMs: row.ttftMs,
        outputTokens: row.completionTokens,
        success: row.success,
        at: row.at,
      },
      window,
    );
    this.models.setPerformance(nextPerf);
    this.store.setModelPerformance(nextPerf);
  }

  /** Persist models from the in-memory registry into the database. */
  reloadModels(): void {
    this.store.upsertModels(this.models.all().map(enrich));
  }

  /** Recompute which providers have a usable credential. */
  refreshCredentialState(): void {
    for (const d of this.providers.list()) {
      this.providers.setCredentialed(d.id, this.credentials.hasAny(d.id));
    }
  }

  newRequestId(): string {
    return newId('req');
  }
}

/**
 * Write generated assets to disk and serve them by path.
 *
 * Data URLs are convenient at the adapter boundary but ruinous everywhere else:
 * a job list holding twenty base64 images is megabytes of JSON per request.
 */
function createAssetStore(assetRoot: string): (jobId: string, index: number, asset: GeneratedAsset) => Promise<GeneratedAsset> {
  return async (jobId, index, asset) => {
    const decoded = decodeDataUrl(asset.url);
    if (!decoded) return asset;
    const name = `${jobId}-${index}.${extensionFor(decoded.mimeType)}`;
    const dir = resolve(assetRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), decoded.bytes);
    return { ...asset, url: `/media/${name}`, bytes: decoded.bytes.byteLength };
  };
}

export type { ServerEvent };
