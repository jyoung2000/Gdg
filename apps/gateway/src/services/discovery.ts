import {
  modelKey,
  nullLogger,
  timeoutSignal,
  type Capability,
  type Logger,
  type MeridianConfig,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
} from '@meridian/shared';
import { ModelRegistry, enrich } from '@meridian/model-sdk';
import { discoverLocalEndpoints, type AdapterContext, type ProviderRegistry } from '@meridian/provider-sdk';
import type { CredentialResolver, HealthStore } from '@meridian/routing-sdk';
import type { Store } from '../db/store.js';

export interface DiscoveryDeps {
  providers: ProviderRegistry;
  models: ModelRegistry;
  credentials: CredentialResolver;
  health: HealthStore;
  store: Store;
  logger: Logger;
  config: MeridianConfig;
  onProvider?: (providerId: string, added: number, removed: number, total: number) => void;
}

const LOCAL_PRICING: Pricing = {
  kind: 'LOCAL',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: 'Runs on your own hardware.',
};

/**
 * Live model and endpoint discovery.
 *
 * Static catalogs go stale: providers add models, withdraw them, and change
 * their context limits without notice. So the catalog is a starting point and
 * the provider's own listing is the authority — which is also why a discovery
 * pass *removes* models the provider no longer serves rather than only adding.
 * Routing to a model that was quietly withdrawn is a failure the user cannot
 * diagnose.
 */
export class Discovery {
  private readonly deps: DiscoveryDeps;
  private running = false;

  constructor(deps: DiscoveryDeps) {
    this.deps = deps;
  }

  /** Discover from every configured provider, plus any local servers. */
  async runOnce(): Promise<{ providers: number; models: number }> {
    if (this.running) return { providers: 0, models: this.deps.models.size() };
    this.running = true;
    try {
      await this.discoverLocal();

      const targets = this.deps.providers.list().filter((d) => {
        if (!d.supportsDiscovery) return false;
        const adapter = this.deps.providers.get(d.id);
        if (!adapter?.listModels) return false;
        return d.auth === 'none' || this.deps.credentials.hasAny(d.id);
      });

      // Providers are probed concurrently: a slow one must not delay the rest,
      // and each has its own timeout anyway.
      const results = await Promise.allSettled(targets.map((d) => this.discoverProvider(d)));
      let discovered = 0;
      for (const r of results) if (r.status === 'fulfilled') discovered += r.value;

      this.deps.store.upsertModels(this.deps.models.all());
      this.deps.logger.info('discovery complete', { providers: targets.length, models: this.deps.models.size() });
      return { providers: targets.length, models: discovered };
    } finally {
      this.running = false;
    }
  }

  private async discoverProvider(descriptor: ProviderDescriptor): Promise<number> {
    const adapter = this.deps.providers.get(descriptor.id);
    if (!adapter?.listModels) return 0;

    const resolution = this.deps.credentials.resolve({ providerId: descriptor.id }, descriptor.auth !== 'none');
    if (!resolution.credential && descriptor.auth !== 'none') return 0;

    const ctx: AdapterContext = {
      secret: resolution.credential?.secret ?? null,
      logger: this.deps.logger.child({ providerId: descriptor.id }),
      requestId: `discovery-${descriptor.id}`,
      timeoutMs: 30_000,
      signal: timeoutSignal(30_000),
    };

    try {
      const raw = await adapter.listModels(ctx);
      const models = raw.map((m) => enrich(m));
      const { added, removed } = this.deps.models.replaceProviderModels(descriptor.id, models);
      if (removed.length) this.deps.store.deleteModels(removed);

      // A provider that answered a listing request is demonstrably reachable
      // and correctly authenticated, which is exactly what "verified" means.
      this.deps.providers.setVerified(descriptor.id, adapter.capabilities());
      this.deps.health.recordProbe(descriptor.id, true, 0);
      this.deps.store.saveProviderOverride(descriptor.id, { verifiedAt: Date.now() });

      this.deps.logger.info('discovered models', {
        providerId: descriptor.id,
        added: added.length,
        removed: removed.length,
        total: models.length,
      });
      this.deps.onProvider?.(descriptor.id, added.length, removed.length, models.length);
      return models.length;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.warn('discovery failed for provider', { providerId: descriptor.id, errorCode: message });
      this.deps.health.recordProbe(descriptor.id, false, 0, message);
      return 0;
    }
  }

  /**
   * Find local inference servers and register the ones that answered.
   *
   * A local endpoint is only registered when it actually responded with a model
   * list — a provider entry for a server that is not running would show up in
   * the UI as available and fail on first use.
   */
  private async discoverLocal(): Promise<void> {
    const endpoints = await discoverLocalEndpoints(this.deps.config.localEndpoints, { timeoutMs: 2500 });
    for (const ep of endpoints) {
      const isOllama = ep.kind === 'ollama';
      const id = isOllama ? 'ollama' : `local-${hostSlug(ep.baseUrl)}`;
      const base = this.deps.providers.descriptor(id);

      if (!base) {
        this.deps.providers.registerProvider({
          id,
          name: isOllama ? 'Ollama' : `Local server (${hostSlug(ep.baseUrl)})`,
          kinds: ['local', 'llm', 'coding'],
          adapter: isOllama ? 'ollama' : 'openai-server',
          baseUrl: isOllama ? `${ep.baseUrl.replace(/\/+$/, '')}/v1` : ep.baseUrl,
          auth: 'none',
          envKeys: [],
          trust: 'verified',
          docsUrl: null,
          local: true,
          supportsDiscovery: true,
          dataUse: {
            trainingUse: 'not_allowed',
            commercialUse: 'unknown',
            retention: 'Nothing leaves this machine.',
            privacyNote:
              'Runs on your own hardware, so no request data reaches a third party. Commercial use depends on the licence of the model you loaded.',
            policyUrl: null,
          },
          defaultPricing: LOCAL_PRICING,
        });
      }

      this.deps.providers.setCredentialed(id, true);
      this.deps.health.recordProbe(id, true, ep.latencyMs);

      // Register the models the probe already reported rather than issuing a
      // second listing call for information we have.
      const models: ModelDescriptor[] = ep.models.map((name) =>
        enrich({
          id: modelKey(id, name),
          providerId: id,
          providerModelId: name,
          displayName: name,
          family: null,
          modalities: ['text'],
          capabilities: ['text', 'streaming'] as Capability[],
          contextLength: null,
          maxOutputTokens: null,
          pricing: LOCAL_PRICING,
          discovered: true,
          deprecated: false,
          tags: ['local'],
          updatedAt: Date.now(),
        }),
      );
      const { added, removed } = this.deps.models.replaceProviderModels(id, models);
      if (removed.length) this.deps.store.deleteModels(removed);
      this.deps.logger.info('local endpoint discovered', { providerId: id, baseUrl: ep.baseUrl, models: models.length, added: added.length });
      this.deps.onProvider?.(id, added.length, removed.length, models.length);
    }
  }

  /**
   * Probe every credentialed provider's liveness.
   *
   * Probes never touch the circuit breaker — the breaker exists to describe
   * what real traffic is experiencing, and a synthetic probe failing (or
   * succeeding) is weaker evidence than an actual request.
   */
  async checkHealth(): Promise<void> {
    const targets = this.deps.providers.list().filter((d) => d.auth === 'none' || this.deps.credentials.hasAny(d.id));

    await Promise.allSettled(
      targets.map(async (d) => {
        const adapter = this.deps.providers.get(d.id);
        if (!adapter?.healthCheck) return;
        const resolution = this.deps.credentials.resolve({ providerId: d.id }, d.auth !== 'none');
        if (!resolution.credential && d.auth !== 'none') return;
        const res = await adapter.healthCheck({
          secret: resolution.credential?.secret ?? null,
          logger: nullLogger,
          requestId: `health-${d.id}`,
          timeoutMs: 15_000,
          signal: timeoutSignal(15_000),
        });
        this.deps.health.recordProbe(d.id, res.ok, res.latencyMs, res.detail);
      }),
    );
  }
}

function hostSlug(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.hostname.replace(/\./g, '-')}-${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return baseUrl.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  }
}
