import { join } from 'node:path';
import type { Logger, MeridianConfig, Pricing } from '@meridian/shared';
import { syncPriceBook, type PriceBook, type PriceBookResult } from '@meridian/model-sdk';

/**
 * Keeps a rate card loaded so cost accounting is not fiction.
 *
 * Without this, Meridian priced every paid provider at zero. The shipped
 * catalog carries a pricing posture rather than rates, and only OpenRouter
 * publishes real per-model prices in its listing, so `computeCost` returned 0
 * for Anthropic, OpenAI, Together, Fireworks and the rest. Three things
 * followed from that, all bad: usage reported $0 on calls that cost money,
 * budget caps could not bind on spend that always computed to zero, and
 * "cheapest route" could not compare routes whose price it could not see.
 *
 * The book is advisory and it says so. A community-maintained rate card is
 * good evidence, not an invoice, so a rate the provider itself published always
 * wins and every book-sourced price is marked as coming from the book.
 */

export interface PriceBookDeps {
  logger: Logger;
  config: MeridianConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PriceBookStatusView {
  source: string;
  status: PriceBookResult['status'] | 'never-run';
  entries: number;
  fromCache: boolean;
  fetchedAt: number | null;
  cacheAgeDays: number | null;
  error: string | null;
  license: string;
  attribution: string;
  /** How many lookups this process served from the book. */
  applied: number;
}

export class PriceBookService {
  private readonly deps: PriceBookDeps;
  private book: PriceBook | null = null;
  private state: Omit<PriceBookStatusView, 'applied'> = {
    source: 'litellm-price-book',
    status: 'never-run',
    entries: 0,
    fromCache: false,
    fetchedAt: null,
    cacheAgeDays: null,
    error: null,
    license: 'MIT',
    attribution:
      'Model rates and context windows from github.com/BerriAI/litellm (MIT), used and redistributed under its licence.',
  };
  private applied = 0;
  private running = false;

  constructor(deps: PriceBookDeps) {
    this.deps = deps;
  }

  private get cacheDir(): string {
    return join(this.deps.config.dataDir, 'catalog-cache');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** `offline` reads only the cache — used at boot so nothing waits on GitHub. */
  async runOnce(opts: { offline?: boolean } = {}): Promise<PriceBookStatusView> {
    if (this.running) return this.status();
    this.running = true;
    try {
      const r = await syncPriceBook({
        cacheDir: this.cacheDir,
        now: this.now(),
        offline: opts.offline,
        fetchImpl: this.deps.fetchImpl,
      });
      // Only replace a working book with another working book. A failed
      // refresh must not leave the gateway pricing everything at zero again.
      if (r.book) this.book = r.book;
      this.state = {
        source: r.source,
        status: r.status,
        entries: r.entries,
        fromCache: r.fromCache,
        fetchedAt: r.fetchedAt,
        cacheAgeDays: r.cacheAgeDays,
        error: r.error,
        license: r.license,
        attribution: r.attribution,
      };
      if (r.status === 'unavailable') {
        this.deps.logger.warn('price book unavailable — paid providers will report unknown cost', {
          error: r.error,
        });
      } else {
        this.deps.logger.info('price book loaded', {
          status: r.status,
          entries: r.entries,
          fromCache: r.fromCache,
        });
      }
      return this.status();
    } finally {
      this.running = false;
    }
  }

  /**
   * Rates for one model, or null when the book does not confidently know.
   *
   * Null is the important case: it leaves the price unknown rather than zero,
   * so the route view shows "—" and cheapest-route comparison excludes it
   * instead of crowning it.
   */
  lookup(providerId: string, providerModelId: string): Pricing | null {
    const facts = this.book?.lookup(providerId, providerModelId);
    if (!facts) return null;
    if (facts.pricing.kind === 'UNKNOWN') return null;
    this.applied += 1;
    return {
      ...facts.pricing,
      note: `Rate from the ${this.state.source} (${facts.matchKind} match on "${facts.matchedKey}"). Community-maintained; confirm against the provider's own pricing page.`,
    };
  }

  /** Context window and capability flags, when the book knows them. */
  limitsFor(providerId: string, providerModelId: string): { contextLength: number | null; maxOutputTokens: number | null } | null {
    const facts = this.book?.lookup(providerId, providerModelId);
    if (!facts) return null;
    if (facts.contextLength === null && facts.maxOutputTokens === null) return null;
    return { contextLength: facts.contextLength, maxOutputTokens: facts.maxOutputTokens };
  }

  get loaded(): boolean {
    return this.book !== null;
  }

  status(): PriceBookStatusView {
    return { ...this.state, applied: this.applied };
  }
}
