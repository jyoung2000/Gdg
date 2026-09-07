import { join } from 'node:path';
import type { Logger, MeridianConfig, ProviderIntelligence } from '@meridian/shared';
import { syncFreeLlmHub, type DatasetChange, type SyncResult } from '@meridian/model-sdk';
import { PROVIDER_CATALOG, type ProviderRegistry } from '@meridian/provider-sdk';

/**
 * Keeps Meridian's provider catalog in step with the free-llm-api-hub dataset.
 *
 * The shipped catalog is hand-written, adapter-backed and small; the dataset is
 * community-maintained, broad, and refreshed far more often than Meridian
 * ships. Syncing lets a free tier that appeared last week become a usable route
 * without a release, which is the whole point of the exercise.
 *
 * Three rules keep that from turning into a liability.
 *
 * A synced provider never overwrites a shipped one. Where both describe the
 * same provider, the shipped descriptor wins — it was written against the real
 * API and has a capability table behind it — and the dataset contributes only
 * the access and economics picture the catalog has no way to know.
 *
 * A synced provider is registered, not enabled. Registration means the router
 * *could* use it; without a credential the registry reports `not_configured`
 * and it is skipped. Nothing here makes a call or spends anything on its own.
 *
 * A synced provider is never presented as verified. It enters with
 * `trust: 'unknown'`, and its {@link ProviderIntelligence} carries the dataset's
 * name, version and check date so the UI can say who claimed what, and when.
 */

export interface CatalogSyncDeps {
  providers: ProviderRegistry;
  logger: Logger;
  config: MeridianConfig;
  /** Surfaced to the operator when a significant change lands. */
  onNotice?: (level: 'info' | 'warn', message: string) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface CatalogSyncStatus {
  source: string;
  /** Null until a sync has run in this process. */
  status: SyncResult['status'] | 'never-run';
  version: string | null;
  /** Date upstream generated the payload being served. */
  generated: string | null;
  fromCache: boolean;
  fetchedAt: number | null;
  cacheAgeDays: number | null;
  /** Providers this sync registered as new, callable routes. */
  registered: number;
  /** Providers already shipped, which the dataset only enriched. */
  enriched: number;
  /** Entries with no callable endpoint, by reason. */
  unroutable: Record<string, number>;
  /** Total entries in the payload. */
  entries: number;
  lastChanges: DatasetChange[];
  error: string | null;
  license: string;
  attribution: string;
}

const NEVER_RUN: Omit<CatalogSyncStatus, 'source' | 'license' | 'attribution'> = {
  status: 'never-run',
  version: null,
  generated: null,
  fromCache: false,
  fetchedAt: null,
  cacheAgeDays: null,
  registered: 0,
  enriched: 0,
  unroutable: {},
  entries: 0,
  lastChanges: [],
  error: null,
};

export class CatalogSync {
  private readonly deps: CatalogSyncDeps;
  private readonly intel = new Map<string, ProviderIntelligence>();
  private state: Omit<CatalogSyncStatus, 'source' | 'license' | 'attribution'> = { ...NEVER_RUN };
  private running = false;

  constructor(deps: CatalogSyncDeps) {
    this.deps = deps;
  }

  private get cacheDir(): string {
    return join(this.deps.config.dataDir, 'catalog-cache');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Run a sync.
   *
   * `offline` reads only what is already cached — used at boot so a gateway
   * with no network still comes up with the providers it knew about last time,
   * rather than silently losing two thirds of its catalog.
   */
  async runOnce(opts: { offline?: boolean } = {}): Promise<CatalogSyncStatus> {
    if (this.running) return this.status();
    this.running = true;
    try {
      // Shipped ids, so the dataset enriches them instead of replacing them.
      const existingIds = new Set(PROVIDER_CATALOG.map((p) => p.id));
      const result = await syncFreeLlmHub({
        cacheDir: this.cacheDir,
        now: this.now(),
        existingIds,
        offline: opts.offline,
        fetchImpl: this.deps.fetchImpl,
      });

      let registered = 0;
      if (result.dataset) {
        this.intel.clear();
        for (const p of result.dataset.providers) {
          this.intel.set(p.intelligence.providerId, p.intelligence);
          if (!p.descriptor) continue;
          // Never clobber a provider that is already registered — the shipped
          // catalog and any runtime local endpoint both outrank an import.
          if (this.deps.providers.descriptor(p.descriptor.id)) continue;
          this.deps.providers.registerProvider(p.descriptor);
          registered += 1;
        }
      }

      this.state = {
        status: result.status,
        version: result.version,
        generated: result.generated,
        fromCache: result.fromCache,
        fetchedAt: result.fetchedAt,
        cacheAgeDays: result.cacheAgeDays,
        registered,
        enriched: result.dataset?.enrichedExisting ?? 0,
        unroutable: result.dataset?.unroutable ?? {},
        entries: result.dataset?.providers.length ?? 0,
        lastChanges: result.changes,
        error: result.error,
      };

      this.report(result, registered);
      return this.status();
    } finally {
      this.running = false;
    }
  }

  private report(result: SyncResult, registered: number): void {
    const log = this.deps.logger;
    if (result.status === 'unavailable') {
      log.warn('provider catalog sync unavailable', { error: result.error });
      return;
    }
    log.info('provider catalog synced', {
      status: result.status,
      version: result.version,
      registered,
      entries: result.dataset?.providers.length ?? 0,
      fromCache: result.fromCache,
    });

    // Only changes that alter whether someone can use a provider are worth
    // interrupting the operator for; wording tweaks are not.
    const significant = result.changes.filter((c) => c.significant);
    for (const c of significant.slice(0, 8)) {
      this.deps.onNotice?.('info', describeChange(c));
    }
    if (result.status === 'stale-cache' && result.error) {
      this.deps.onNotice?.(
        'warn',
        `Provider catalog could not refresh (${result.error}). Showing data cached ${result.cacheAgeDays ?? '?'} day(s) ago.`,
      );
    }
  }

  status(): CatalogSyncStatus {
    return {
      source: 'free-llm-api-hub',
      license: 'MIT',
      attribution: 'Data from github.com/pacocartones/free-llm-api-hub (MIT), used and redistributed under its licence.',
      ...this.state,
    };
  }

  /** Access/economics intelligence for one provider, when the sync knows it. */
  for(providerId: string): ProviderIntelligence | null {
    return this.intel.get(providerId) ?? null;
  }

  all(): ProviderIntelligence[] {
    return [...this.intel.values()];
  }
}

export function describeChange(c: DatasetChange): string {
  switch (c.kind) {
    case 'provider-added':
      return `New free provider: ${c.providerName}`;
    case 'provider-removed':
      return `Provider withdrawn from the free catalog: ${c.providerName}`;
    case 'free-access-changed':
      return `${c.providerName}: free access changed from ${c.before} to ${c.after}`;
    case 'free-tier-changed':
      return `${c.providerName}: free tier changed`;
    case 'card-requirement-changed':
      return `${c.providerName}: card requirement is now ${c.after ?? 'unknown'}`;
    case 'phone-requirement-changed':
      return `${c.providerName}: phone requirement is now ${c.after ?? 'unknown'}`;
    case 'commercial-use-changed':
      return `${c.providerName}: commercial-use permission is now ${c.after ?? 'unknown'}`;
    case 'endpoint-changed':
      return `${c.providerName}: API endpoint changed`;
    default:
      return `${c.providerName}: ${c.kind.replace(/-/g, ' ')}`;
  }
}
