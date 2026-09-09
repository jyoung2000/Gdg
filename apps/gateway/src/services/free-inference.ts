import { join } from 'node:path';
import type { Logger, MeridianConfig } from '@meridian/shared';
import {
  DiscoveryRegistry,
  datasetSources,
  nativeSources,
  rankFreeInference,
  type DiscoveryContext,
  type DiscoverySource,
  type MergeResult,
  type MergedModel,
  type MergedProvider,
  type RankOptions,
  type RankResult,
} from '@meridian/model-sdk';
import { DiscoveryScheduler } from '@meridian/control-sdk';

/**
 * The free-inference discovery engine, as a service.
 *
 * Every source is a plugin, every claim keeps its origin, and the merged
 * picture is what the UI and the router read. Three things about the shape of
 * this are deliberate.
 *
 * **Boot reads the cache and nothing else.** A gateway must come up when GitHub
 * is down, and it must come up in the same time either way. The first network
 * refresh is a scheduled event after start, not part of start.
 *
 * **Refresh is paced by the same scheduler the provider discovery uses.** These
 * are free, community-run repositories; a gateway that polls them every minute
 * is the reason a free thing stops being free. The scheduler already implements
 * a minimum interval, exponential backoff with jitter, and a pause after
 * repeated failure — reusing it means one set of manners, tested once.
 *
 * **Nothing here is enabled by discovering it.** Finding a provider that offers
 * free inference registers nothing, spends nothing and calls nothing. It puts a
 * row in a list with a source and a date attached. Acting on it is the
 * operator's decision, which is the difference between a catalogue and a
 * gateway that signs itself up for things.
 */

export interface FreeInferenceDeps {
  logger: Logger;
  config: MeridianConfig;
  /** Whether a provider is registered and has a credential right now. */
  reachable?: (providerId: string) => boolean | null;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sources?: DiscoverySource[];
}

export interface SourceStatus {
  id: string;
  displayName: string;
  sourceClass: string;
  ok: boolean;
  fromCache: boolean;
  cacheAgeDays: number | null;
  providers: number;
  models: number;
  error: string | null;
  license: string;
  attribution: string;
  /** When this source may next be refreshed, and why not sooner. */
  nextEligibleAt: number | null;
  consecutiveFailures: number;
}

export interface FreeInferenceStatus {
  lastRunAt: number | null;
  everRanOnline: boolean;
  providers: number;
  models: number;
  freeModels: number;
  sources: SourceStatus[];
  /** Claims dropped because the source had no standing to make them. */
  refusals: MergeResult['refusals'];
}

/** How often a dataset is worth re-reading. They change daily at most. */
const MIN_REFRESH_MS = 6 * 60 * 60_000;

export class FreeInferenceService {
  private readonly registry: DiscoveryRegistry;
  private readonly scheduler: DiscoveryScheduler;
  private merged: MergeResult = { providers: [], models: [], sources: [], refusals: [] };
  private lastRunAt: number | null = null;
  private everRanOnline = false;
  private running = false;

  constructor(private readonly deps: FreeInferenceDeps) {
    this.registry = new DiscoveryRegistry().registerAll(deps.sources ?? [...datasetSources(), ...nativeSources()]);
    this.scheduler = new DiscoveryScheduler({
      minIntervalMs: MIN_REFRESH_MS,
      baseBackoffMs: 5 * 60_000,
      maxBackoffMs: 12 * 60 * 60_000,
      now: () => this.now(),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get cacheDir(): string {
    return join(this.deps.config.dataDir, 'discovery-cache');
  }

  private context(offline: boolean, existingIds: ReadonlySet<string>): DiscoveryContext {
    return {
      cacheDir: this.cacheDir,
      now: this.now(),
      offline,
      timeoutMs: 20_000,
      fetchImpl: this.deps.fetchImpl,
      existingIds,
    };
  }

  /**
   * Load every source that is due, merge, and keep the result.
   *
   * A source that is not due is still loaded — from its cache, offline — so it
   * keeps contributing to the merge. Skipping it entirely would make a merged
   * catalogue that shrinks and grows depending on which sources happened to be
   * due, which is worse than a slightly stale one.
   */
  async refresh(opts: { offline?: boolean; force?: boolean; existingIds?: ReadonlySet<string> } = {}): Promise<FreeInferenceStatus> {
    if (this.running) return this.status();
    this.running = true;
    try {
      const existingIds = opts.existingIds ?? new Set<string>();
      const due = new Map<string, boolean>();
      for (const meta of this.registry.list()) {
        const verdict = opts.offline ? { allowed: false } : this.scheduler.canRun(meta.id, { force: opts.force });
        due.set(meta.id, verdict.allowed);
        if (verdict.allowed) this.scheduler.markAttempt(meta.id);
      }

      // One context per source, because "offline" differs per source: the ones
      // that are not due read their cache while the due ones go to the network.
      const anyOnline = [...due.values()].some(Boolean);
      this.merged = await this.registry.load(this.context(!anyOnline, existingIds));

      for (const source of this.merged.sources) {
        if (!due.get(source.id)) continue;
        if (source.ok) this.scheduler.markSuccess(source.id);
        else this.scheduler.markFailure(source.id, source.error ?? 'unknown');
      }

      this.lastRunAt = this.now();
      if (anyOnline && this.merged.sources.some((s) => s.ok && !s.fromCache)) this.everRanOnline = true;

      const failed = this.merged.sources.filter((s) => !s.ok);
      if (failed.length) {
        this.deps.logger.info('discovery: some sources did not load', {
          failed: failed.map((s) => s.id).join(','),
          working: this.merged.sources.filter((s) => s.ok).length,
        });
      }
      return this.status();
    } finally {
      this.running = false;
    }
  }

  status(): FreeInferenceStatus {
    const free = this.rank({ now: this.now() });
    return {
      lastRunAt: this.lastRunAt,
      everRanOnline: this.everRanOnline,
      providers: this.merged.providers.length,
      models: this.merged.models.length,
      freeModels: free.models.length,
      sources: this.merged.sources.map((s) => {
        const schedule = this.scheduler.scheduleOf(s.id);
        return {
          ...s,
          // Rounded: the scheduler adds sub-millisecond jitter, and a
          // fractional epoch in a JSON API is noise every consumer has to
          // decide what to do with.
          nextEligibleAt: schedule.nextEligibleAt ? Math.round(schedule.nextEligibleAt) : null,
          consecutiveFailures: schedule.consecutiveFailures,
        };
      }),
      refusals: this.merged.refusals,
    };
  }

  providers(): MergedProvider[] {
    return this.merged.providers;
  }

  provider(id: string): MergedProvider | undefined {
    return this.merged.providers.find((p) => p.providerId === id);
  }

  models(): MergedModel[] {
    return this.merged.models;
  }

  rank(opts: Omit<RankOptions, 'reachable'> & { reachable?: RankOptions['reachable'] }): RankResult {
    return rankFreeInference(this.merged.models, this.merged.providers, {
      ...opts,
      reachable: opts.reachable ?? this.deps.reachable,
    });
  }

  /** Everything that has to be reproduced in the notices file. */
  attributions(): { source: string; license: string; attribution: string }[] {
    return this.merged.sources.map((s) => ({ source: s.id, license: s.license, attribution: s.attribution }));
  }
}
