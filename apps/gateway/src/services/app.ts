import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  quotaFraction,
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
import { BUILTIN_POOLS, CredentialHealthStore, CredentialResolver, Executor, HealthStore, ModelHealthStore, PoolManager, Router } from '@meridian/routing-sdk';
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
import { VerificationService } from './verification.js';
import { CatalogSync } from './catalog-sync.js';
import { FreeInferenceService } from './free-inference.js';
import { PriceBookService } from './price-book.js';
import { EventBus, type ServerEvent } from './events.js';
import { browserTools, createControlPlane, type ControlPlane } from './control.js';
import { createAIControlPlane, type ControlPlane as AIControlPlane } from './control-plane.js';
import { ComputerService } from './computer.js';
import { mcpAgentTools, selectMcpTools, type McpToolPolicy } from './mcp-tools.js';

export interface Warning {
  level: 'info' | 'warn';
  message: string;
}

interface AppParts {
  verification: VerificationService;
  config: MeridianConfig;
  logger: Logger;
  store: Store;
  providers: ProviderRegistry;
  models: ModelRegistry;
  health: HealthStore;
  credentialHealth: CredentialHealthStore;
  modelHealth: ModelHealthStore;
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
  catalogSync: CatalogSync;
  freeInference: FreeInferenceService;
  priceBook: PriceBookService;
  control: ControlPlane;
  ai: AIControlPlane;
  computer: ComputerService;
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
  /** Health and published quota per account, which is per credential. */
  readonly credentialHealth: CredentialHealthStore;
  /** Health per model, so one retired model id cannot retire its provider. */
  readonly modelHealth: ModelHealthStore;
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
  /** Keeps the provider catalog in step with the free-model dataset. */
  readonly catalogSync: CatalogSync;
  /** Every source of free-inference knowledge, merged under precedence. */
  readonly freeInference: FreeInferenceService;
  /** Rates for paid providers, so cost accounting is not always zero. */
  readonly priceBook: PriceBookService;
  readonly control: ControlPlane;
  /** Capability probes: the only thing that can write `probe_verified`. */
  readonly verification: VerificationService;
  /** Skills, AI profiles and scoped assignments. */
  readonly ai: AIControlPlane;
  /** Computer-control backends and sessions. Off unless a session is started. */
  readonly computer: ComputerService;
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
    this.credentialHealth = parts.credentialHealth;
    this.modelHealth = parts.modelHealth;
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
    this.catalogSync = parts.catalogSync;
    this.freeInference = parts.freeInference;
    this.priceBook = parts.priceBook;
    this.control = parts.control;
    this.verification = parts.verification;
    this.ai = parts.ai;
    this.computer = parts.computer;
    this.warnings = parts.warnings;
  }

  static async create(config: MeridianConfig): Promise<App> {
    // Filled in at the end of this method; see recordUsage below.
    let instance: App | null = null;
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
    for (const s of store.listModelScores()) models.setScores(s);
    for (const p of store.listModelPerformance()) models.setPerformance(p);

    /* ---- Rates ----------------------------------------------------- */
    // Loaded from the on-disk cache before the registry is built, because the
    // registry's pricing lookup closes over it. Offline at boot for the same
    // reason as the catalog: a gateway must not wait on a third-party host,
    // and must not come up pricing everything at zero because one was slow.
    const priceBook = new PriceBookService({ logger, config });
    await priceBook.runOnce({ offline: true });

    /* ---- Providers ------------------------------------------------ */
    const providers = createRegistry({
      pricingLookup: (providerId, providerModelId) => {
        // Order matters, most authoritative first.
        //
        // 1. A rate already carrying real numbers — that came either from the
        //    provider's own listing or from a previous book lookup, and either
        //    way re-deriving it would only add churn.
        const known = models.get(`${providerId}:${providerModelId}`)?.pricing ?? null;
        if (known && (known.inputPerMTok !== null || known.outputPerMTok !== null)) return known;
        // 2. The community price book. Returns null rather than guessing when
        //    it cannot confidently match the model AT THIS provider, which
        //    leaves the price unknown instead of wrong.
        return priceBook.lookup(providerId, providerModelId) ?? known;
      },
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
      // An operator's "disable this provider" and a recorded live verification
      // both have to survive a restart, or the toggle is decoration and every
      // reboot forgets what was proven.
      if (o.enabled === false) providers.setEnabled(d.id, false);
      if (o.verifiedAt != null) providers.setVerifiedAt(d.id, o.verifiedAt);
    }

    /* ---- Synced provider catalog ---------------------------------- */
    // Registered from the on-disk cache before anything reconciles models
    // against the provider set: a synced provider that vanished here would
    // take its previously-discovered models down with it as "orphaned".
    //
    // Offline on purpose. Boot must not wait on GitHub, and must not fail
    // because it is unreachable; a refresh over the network is a separate,
    // scheduled concern.
    const catalogSync = new CatalogSync({
      providers,
      logger,
      config,
      onNotice: (level, message) => warnings.push({ level, message }),
    });
    await catalogSync.runOnce({ offline: true });


    // Persisted models are only trustworthy while their provider exists. A
    // dynamically-discovered local server from a previous run leaves its models
    // in the database; loading them without their provider would hand the
    // router candidates it can only reject with "provider is not registered".
    // They are dropped here and come back the moment discovery sees the
    // endpoint again — discovery is the authority on what exists, the database
    // is only a warm start.
    const persisted = store.listModels();
    const orphaned = persisted.filter((m) => !providers.descriptor(m.providerId));
    models.upsertMany(persisted.filter((m) => providers.descriptor(m.providerId)));
    if (orphaned.length) {
      store.deleteModels(orphaned.map((m) => m.id));
      logger.info('dropped models from unregistered providers', {
        count: orphaned.length,
        providerIds: [...new Set(orphaned.map((m) => m.providerId))].join(','),
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

    /* ---- Health, per service and per account ----------------------- */
    // Built before the resolver, because the resolver consults it: an account
    // on a rate-limit cooldown is not capacity, and handing it out anyway is
    // how a request fails on a key the router already knew was busy.
    const credentialHealth = new CredentialHealthStore();
    credentialHealth.load(store.listCredentialHealth(), store.listCredentialQuota());
    credentialHealth.onChange((h) => store.saveCredentialHealth(h));
    credentialHealth.onQuota((q) => store.saveCredentialQuota(q));

    const credentials = new CredentialResolver(store, () => Date.now(), credentialHealth);

    // The discovery engine, from cache only: a gateway has to come up when
    // GitHub is down, and come up in the same time either way. The first
    // network refresh is a scheduled event after start, not part of start.
    //
    // Constructed *after* the credential resolver, and not a line earlier.
    // `reachable` closes over `credentials`, and the boot refresh ranks what it
    // loaded — so with an empty cache nothing is ranked and nothing notices,
    // while on the second boot the cache has models, the closure runs, and the
    // gateway dies in the temporal dead zone before it can say why. First run
    // fine, every run after it broken, is the shape of bug worth moving four
    // lines to make impossible.
    const freeInference = new FreeInferenceService({
      logger,
      config,
      reachable: (providerId) => {
        if (!providers.descriptor(providerId)) return null;
        return credentials.resolve({ providerId }, true).credential !== null;
      },
    });
    await freeInference.refresh({ offline: true, existingIds: new Set(PROVIDER_CATALOG.map((p) => p.id)) });
    for (const d of providers.list()) providers.setCredentialed(d.id, credentials.hasAny(d.id));

    const health = new HealthStore();
    health.load(store.listHealth());
    health.onChange((h) => store.saveHealth(h));

    // Per-model health is deliberately in-memory. A retired model id is
    // corrected by the next discovery pass, which rewrites the catalog anyway;
    // persisting a cooldown across a restart would outlive the fact it was
    // about and keep a model out of rotation after the provider brought it
    // back.
    const modelHealth = new ModelHealthStore();

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
      modelHealth,
      credentials,
      pools,
      allowPaid: () => config.allowPaid,
      preferencesFor,
      /**
       * How much of this provider's free allowance is left.
       *
       * Read from what providers actually told us — the rate-limit headers on
       * previous responses, recorded per credential. `null` when nothing has
       * been published, which is most providers most of the time, and null is
       * deliberately not 1: an account nobody has published a limit for is not
       * an account with a full allowance.
       *
       * The best of the credentials is what counts. If one key is spent and
       * another has room, this provider has room — the credential resolver
       * will pick the one that works.
       */
      quotaHeadroom: (providerId) => {
        const fractions = store
          .listForProvider(providerId)
          .flatMap((c) => credentialHealth.quotasFor(c.id))
          .map((q) => quotaFraction(q, Date.now()))
          .filter((f): f is number => f !== null);
        return fractions.length ? Math.max(...fractions) : null;
      },
    });

    const executor = new Executor({
      router,
      models,
      providers,
      health,
      credentialHealth,
      modelHealth,
      credentials,
      pools,
      logger,
      recordUsage: (row) => {
        store.recordUsage(row);
        // A usage row names the model, the prompt size and the money spent on
        // one person's request. It goes to that person and to an administrator.
        events.publish({ type: 'usage', record: row }, { userId: row.userId });
        // Every completed call feeds the measurement pipeline, not just the
        // ones a user later rates. Latency percentiles, jitter and uptime are
        // only meaningful if they come from ordinary traffic — measuring the
        // rare rated task and calling it the model's p95 would be a number
        // built from an unrepresentative sample.
        instance?.recordOutcome(row);
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

    const control = createControlPlane({ config, store, executor, events, logger });
    await control.mcp.load();

    // The shared registry plus the real-browser tools: any agent definition
    // that names browse/browser_act/web_extract can now actually drive a page.
    const baseTools = createToolRegistry({ webAccess: config.sandboxNetwork });
    const tools = new Map([...baseTools, ...browserTools(control).map((t) => [t.definition.name, t] as const)]);

    const media = new MediaEngine({
      executor,
      logger,
      persist: (job) => store.saveGenerationJob(job),
      onUpdate: (job) => events.publish({ type: 'generation', job }, { userId: job.userId }),
      storeAsset: createAssetStore(config.assetRoot),
    });
    for (const corrected of media.load(store.listGenerationJobs(200))) store.saveGenerationJob(corrected);

    /**
     * Whose task an event belongs to.
     *
     * A task event carries a person's prompt, the model's answer and the diff
     * it produced. Only `task-update` names its owner outright; the rest name
     * a step or nothing at all, so the owner is learned as the run goes and
     * remembered. The map is bounded by the tasks a process has actually seen
     * and each entry is a task id and a user id.
     */
    const ownerOfTask = new Map<string, string | null>();
    const taskOfStep = new Map<string, string>();
    const taskEventOwner = (event: TaskEvent): string | null => {
      if (event.type === 'task-update') {
        ownerOfTask.set(event.task.id, event.task.userId);
        return event.task.userId;
      }
      if (event.type === 'step-update') {
        taskOfStep.set(event.step.id, event.step.taskId);
        return ownerOfTask.get(event.step.taskId) ?? store.getTask(event.step.taskId)?.userId ?? null;
      }
      if (event.type === 'agent') {
        const taskId = taskOfStep.get(event.event.stepId);
        return taskId ? (ownerOfTask.get(taskId) ?? null) : null;
      }
      // A bare diff names no task. It is the one shape that cannot be
      // attributed, and the route that publishes it attributes it instead.
      return null;
    };

    const orchestrator = new Orchestrator({
      executor,
      router,
      models,
      tools,
      sandbox,
      logger,
      commandTimeoutMs: config.sandboxTimeoutMs,
      // The one judgement Meridian can make for itself. A model whose code
      // fails its own tests should learn from that, and until now nothing told
      // it: `testsPassed` had no producer anywhere in the codebase.
      //
      // Matched by STEP, not by role. Role was what a usage row happened to
      // record, and it was wrong the moment escalation shipped: a failing
      // check appends a repair attempt and re-runs the tester, so a task can
      // hold two `tester` steps. Matching by role applied the second run's
      // pass to the first run's calls, crediting the model that failed with a
      // verdict it never earned — in the one loop built to be honest about
      // exactly that.
      onVerification: ({ taskId, stepId, passed }) => {
        for (const row of store.listUsage({ taskId, stepId })) {
          instance?.recordOutcome(row, { testsPassed: passed });
        }
      },
      persistStep: (step) => store.saveStep(step),
      persistTask: (task) => store.saveTask(task),
      persistToolCall: (record) => store.saveToolCall(record),
      persistCheckpoint: (taskId, stepId, checkpoint) => store.saveCheckpoint(taskId, stepId, checkpoint),
      onEvent: (event: TaskEvent) => events.publish({ type: 'task', event }, { userId: taskEventOwner(event) }),
    });

    const parallel = new ParallelRunner(orchestrator);
    const ai = await createAIControlPlane({ store, models, mcp: control.mcp, logger });
    const discovery = new Discovery({
      providers,
      models,
      credentials,
      health,
      store,
      logger,
      config,
      scheduler: ai.scheduler,
      onModelChange: (change) => events.publish({ type: 'model-change', change }),
    });

    // Probes cost money and quota, so this is constructed idle and runs only
    // when a person asks it to. Nothing here is on a timer.
    const verification = new VerificationService({ providers, models, credentials, store, logger });

    // The computer agent is constructed but idle: registering backends probes
    // nothing and starts nothing, so a gateway that never runs a session pays
    // no cost and holds no control over the machine.
    //
    // The registry is referenced through a holder rather than through
    // `computer` itself: the event hook is passed *into* the constructor, so
    // naming the const it is about to produce would read it before it exists.
    let computerSessions: ComputerService['sessions'] | null = null;
    const computer = new ComputerService({
      executor,
      models,
      providers,
      credentials,
      health,
      browser: control.browser,
      logger,
      grounding: config.computerGrounding,
      startUrl: config.computerStartUrl,
      onEvent: (event) => events.publish({ type: 'computer', event }, { userId: computerSessions?.find(event.sessionId)?.userId ?? null }),
      persistSession: (info) =>
        store.saveComputerSession({
          id: info.id,
          state: info.state,
          task: info.config.task,
          config: info.config,
          activeBackendId: info.activeBackendId,
          activeModelId: info.activeModelId,
          step: info.step,
          summary: info.summary,
          error: info.error,
          userId: info.userId,
          workspaceId: info.config.workspaceId,
          createdAt: info.createdAt,
          updatedAt: info.updatedAt,
          finishedAt: info.finishedAt,
        }),
      persistAction: (record) => store.saveComputerAction(record),
      skillPrompt: (modelId) => {
        const effective = ai.profiles.effectiveConfig({ modelId });
        return ai.profiles.skillPrompt(effective);
      },
    });
    computerSessions = computer.sessions;

    const app = new App({
      config,
      logger,
      store,
      providers,
      models,
      health,
      credentialHealth,
      modelHealth,
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
      verification,
      catalogSync,
      freeInference,
      priceBook,
      control,
      ai,
      computer,
      warnings,
    });
    instance = app;
    return app;
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

    // Budget counters are memory-held; a restart must not grant a pool its
    // whole daily budget again. Today's persisted usage is the ground truth.
    this.pools.hydrateSpend(this.store.spentTodayByPool());

    await this.discovery.runOnce();
    this.discoveredAt = Date.now();

    if (this.config.discoveryIntervalMs > 0) {
      this.every(this.config.discoveryIntervalMs, () => this.discovery.runOnce(), 'discovery');
    }
    if (this.config.healthIntervalMs > 0) {
      this.every(this.config.healthIntervalMs, () => this.discovery.checkHealth(), 'health check');
    }

    // The datasets, over the network, after start rather than during it. The
    // service's own scheduler decides which sources are actually due, so this
    // interval is how often it is *asked*, not how often anything is fetched:
    // these are free, community-run repositories, and the polite interval is
    // measured in hours.
    const refreshDatasets = () =>
      this.freeInference.refresh({ existingIds: new Set(PROVIDER_CATALOG.map((p) => p.id)) });
    void refreshDatasets().catch((e: unknown) =>
      this.logger.warn('the first discovery refresh failed', { errorCode: e instanceof Error ? e.message : String(e) }),
    );
    this.every(60 * 60_000, refreshDatasets, 'discovery refresh');
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
    // Stop every computer session first: an orphaned backend process holding
    // a display or a browser is the worst thing to leave behind.
    await this.computer.stopAll().catch(() => undefined);
    // shutdown, not closeAll: the browser processes go too, or the gateway
    // leaves one behind on every restart.
    await this.control.browser.shutdown().catch(() => undefined);
    await this.control.mcp.disconnectAll().catch(() => undefined);
    await this.control.docker.cleanupSession().catch(() => undefined);
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
   * Fold a completed call into what is known about the model.
   *
   * Only telemetry feeds this — success, latency, whether tests passed, whether
   * tool calls parsed, and explicit user feedback. The content of the request is
   * never part of what is learned.
   *
   * Availability and quality are recorded separately, because they answer
   * different questions and a provider's refusal answers only one of them. A
   * 429 means the provider would not serve the request; it says nothing about
   * how good the model's output is, and its 5ms round trip is not evidence that
   * the model is fast. Folding refusals into quality and latency would let a
   * rate-limited hour rewrite a model's reputation and pull its latency
   * distribution toward zero — and would quietly overrule an operator who
   * explicitly preferred that provider, since the circuit breaker in
   * ProviderHealth already handles "this provider is not serving right now".
   */
  recordOutcome(
    row: UsageRecord,
    extra: { testsPassed?: boolean | null; toolCallsValid?: boolean | null; userFeedback?: 'positive' | 'negative' | null } = {},
  ): void {
    const judged =
      extra.userFeedback != null || extra.testsPassed != null || extra.toolCallsValid != null;

    // Quality is a JUDGEMENT, and only a judgement updates it: a passing test
    // suite, valid tool calls, or a human saying it was good or bad.
    //
    // A call merely completing is not evidence of quality. The scoring ladder
    // behind this awards a flat 70 for any success, so folding every request
    // into it would let a chatty model out-rank a better one on volume alone,
    // and would quietly outvote an operator who named a preferred provider —
    // learned averages overruling an explicit instruction. Latency and uptime
    // below are measurements and are recorded from every call; this is not.
    if (judged) {
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
    }

    // Performance describes how a model serves, so only a call that actually
    // served contributes to it. A refusal is a fact about the PROVIDER — it is
    // recorded by ProviderHealth, which already tracks error rate, consecutive
    // failures and the circuit breaker, and which the router reads separately.
    // Writing refusals in here too would penalise the model twice for someone
    // else's rate limit, and would let a rate-limited hour override an operator
    // who deliberately preferred that provider.
    if (!row.success) return;

    const window = [...(this.latencyWindows.get(row.modelId) ?? []), row.latencyMs].slice(-100);
    this.latencyWindows.set(row.modelId, window);
    const nextPerf = applyPerformance(
      this.models.getPerformance(row.modelId),
      {
        modelId: row.modelId,
        latencyMs: row.latencyMs,
        ttftMs: row.ttftMs,
        outputTokens: row.completionTokens,
        success: true,
        at: row.at,
      },
      window,
    );
    this.models.setPerformance(nextPerf);
    this.store.setModelPerformance(nextPerf);
  }

  /** Persist models from the in-memory registry into the database. */
  reloadModels(): void {
    this.store.upsertModels(this.models.all().map((m) => enrich(m)));
  }

  /** Recompute which providers have a usable credential. */
  refreshCredentialState(): void {
    for (const d of this.providers.list()) {
      this.providers.setCredentialed(d.id, this.credentials.hasAny(d.id));
    }
  }

  /**
   * The MCP tools that apply to this request, as agent tools.
   *
   * Two layers of scoping, and both are the operator's rather than a guess.
   * The control plane's effective configuration decides which *servers* apply
   * here — global, provider, model, profile, workspace and session assignments,
   * most specific winning. Selection then decides which of their *tools* are
   * worth the context they cost.
   *
   * Returns an empty map rather than throwing when MCP is unconfigured, which
   * is the common case: an instance with no servers installed gets exactly the
   * behaviour it had before this existed.
   */
  mcpToolsFor(ctx: {
    workspaceId?: string | null;
    sessionId?: string | null;
    profileId?: string | null;
    modelId?: string | null;
    providerId?: string | null;
    request: string;
    policy?: McpToolPolicy;
  }): ToolRegistry {
    const empty: ToolRegistry = new Map();
    try {
      const config = this.ai.profiles.effectiveConfig({
        profileId: ctx.profileId ?? null,
        modelId: ctx.modelId ?? null,
        providerId: ctx.providerId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        sessionId: ctx.sessionId ?? null,
      });
      const serverIds = config.mcpServers.map((s) => s.serverId);
      if (!serverIds.length) return empty;

      const selection = selectMcpTools({
        mcp: this.control.mcp,
        serverIds,
        request: ctx.request,
        policy: ctx.policy,
        context: { workspaceId: ctx.workspaceId ?? null, sessionId: ctx.sessionId ?? null },
        // A built-in tool must never be shadowed: an agent asking for
        // `read_file` has to get Meridian's, whatever a server calls its own.
        reserved: new Set(this.tools.keys()),
      });
      return mcpAgentTools(this.control.mcp, selection, {
        workspaceId: ctx.workspaceId ?? null,
        sessionId: ctx.sessionId ?? null,
      });
    } catch (e) {
      // A misconfigured MCP server must not stop a task from running: the
      // agents' own tools are unaffected, so the honest degradation is "no MCP
      // tools this time", logged.
      this.logger.warn('could not resolve MCP tools for this request', {
        errorCode: e instanceof Error ? e.message : String(e),
      });
      return empty;
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


