import {
  nullLogger,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type ResolvedCredential,
} from '@meridian/shared';
import { ModelRegistry } from '@meridian/model-sdk';
import { OpenAICompatibleAdapter, ProviderRegistry } from '@meridian/provider-sdk';
import {
  BUILTIN_POOLS,
  CredentialHealthStore,
  CredentialResolver,
  Executor,
  HealthStore,
  MemoryCredentialStore,
  PoolManager,
  Router,
} from '@meridian/routing-sdk';

export const FREE: Pricing = { kind: 'FREE', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };
export const PAID: Pricing = { kind: 'METERED', inputPerMTok: 3, outputPerMTok: 15, perRequest: null, note: null };
export const LOCAL: Pricing = { kind: 'LOCAL', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };

export function model(overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'id' | 'providerId' | 'providerModelId'>): ModelDescriptor {
  return {
    displayName: overrides.providerModelId,
    family: null,
    modalities: ['text'],
    capabilities: ['text', 'streaming', 'tools'],
    contextLength: 32_768,
    maxOutputTokens: 4096,
    pricing: FREE,
    discovered: false,
    deprecated: false,
    tags: [],
    updatedAt: 0,
    ...overrides,
  };
}

export interface Harness {
  models: ModelRegistry;
  providers: ProviderRegistry;
  health: HealthStore;
  /** Per-account health, wired exactly as the gateway wires it. */
  credentialHealth: CredentialHealthStore;
  credentials: CredentialResolver;
  credentialStore: MemoryCredentialStore;
  pools: PoolManager;
  router: Router;
  executor: Executor;
  /** Deterministic clock, so cooldowns and reservations are testable. */
  advance(ms: number): void;
  now(): number;
}

/**
 * Build the whole routing stack over in-memory stores and a controllable clock.
 *
 * The clock matters: circuit-breaker cooldowns and reservation windows are
 * time-dependent, and a test that sleeps for a real cooldown is a test nobody
 * runs.
 */
export function createHarness(opts: {
  providers: ProviderDescriptor[];
  models: ModelDescriptor[];
  credentials?: ResolvedCredential[];
  allowPaid?: boolean;
} = { providers: [], models: [] }): Harness {
  let clock = 1_700_000_000_000;
  const now = (): number => clock;

  const providers = new ProviderRegistry();
  providers.registerAdapter('openai-compatible', (d) =>
    new OpenAICompatibleAdapter(d, {
      supports: { chat: true, streaming: true, tools: true, embedding: true, discovery: true },
    }),
  );
  for (const d of opts.providers) {
    providers.registerProvider(d);
    providers.setCredentialed(d.id, true);
  }

  const models = new ModelRegistry();
  models.upsertMany(opts.models);

  const health = new HealthStore({ now });
  const credentialHealth = new CredentialHealthStore({ now });
  const credentialStore = new MemoryCredentialStore(opts.credentials ?? []);
  const credentials = new CredentialResolver(credentialStore, now, credentialHealth);
  const pools = new PoolManager(now);
  pools.load(BUILTIN_POOLS.map((p) => ({ ...p, createdAt: 0 })), []);

  const router = new Router({
    models,
    providers,
    health,
    credentials,
    pools,
    allowPaid: () => opts.allowPaid ?? false,
    now,
  });

  const executor = new Executor({
    router,
    models,
    providers,
    health,
    credentialHealth,
    credentials,
    pools,
    logger: nullLogger,
    now,
    // Zero jitter keeps backoff deterministic; the delays themselves are short
    // enough not to slow the suite.
    random: () => 0,
  });

  return {
    models,
    providers,
    health,
    credentialHealth,
    credentials,
    credentialStore,
    pools,
    router,
    executor,
    advance(ms) {
      clock += ms;
    },
    now,
  };
}

export function credential(overrides: Partial<ResolvedCredential> & Pick<ResolvedCredential, 'id' | 'providerId'>): ResolvedCredential {
  return {
    scope: 'system',
    source: 'user-entered',
    label: 'test',
    userId: null,
    workspaceId: null,
    poolId: null,
    priority: 100,
    enabled: true,
    hint: '••••test',
    maxConcurrency: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: 0,
    secret: 'secret-value',
    ...overrides,
  };
}
