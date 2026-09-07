/**
 * Fetching and caching the price book.
 *
 * Same discipline as the provider catalog sync: boot reads only the cache, a
 * failed refresh keeps serving the last good copy with its age attached, and a
 * malformed payload is rejected before it can overwrite anything. A gateway
 * that lost its rate card because GitHub was briefly unreachable would start
 * reporting $0 again, which is the exact failure this module exists to end.
 *
 * The payload is ~2.3MB, so it is fetched with an ETag and a 304 costs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PriceBook, DEFAULT_PRICE_BOOK_URL, LITELLM_SOURCE_ID } from './litellm-pricing.js';

interface CacheEnvelope {
  etag: string | null;
  fetchedAt: number;
  url: string;
  payload: unknown;
}

export type PriceBookStatus = 'updated' | 'not-modified' | 'stale-cache' | 'unavailable';

export interface PriceBookResult {
  status: PriceBookStatus;
  /** Null only when status is 'unavailable'. */
  book: PriceBook | null;
  entries: number;
  fromCache: boolean;
  fetchedAt: number | null;
  cacheAgeDays: number | null;
  error: string | null;
  source: string;
  license: string;
  attribution: string;
}

export interface PriceBookOptions {
  cacheDir: string;
  now: number;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  offline?: boolean;
}

const DAY_MS = 86_400_000;

export function priceBookCachePath(cacheDir: string): string {
  return join(cacheDir, `${LITELLM_SOURCE_ID}.json`);
}

function readCache(cacheDir: string): CacheEnvelope | null {
  const p = priceBookCachePath(cacheDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CacheEnvelope;
  } catch {
    return null;
  }
}

/**
 * Accept a payload only if it looks like the price book.
 *
 * Deliberately structural rather than a full schema: the file is 3,850
 * heterogeneous entries and validating every one would reject the whole rate
 * card over a single new field. What must be true is that it is an object with
 * a plausible number of entries and that a good fraction carry a provider — a
 * 404 page, an error JSON or a truncated download all fail that.
 */
export function looksLikePriceBook(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length < 100) return false;
  let withProvider = 0;
  for (const [, v] of entries.slice(0, 400)) {
    if (v && typeof v === 'object' && 'litellm_provider' in (v as object)) withProvider += 1;
  }
  return withProvider >= 50;
}

/**
 * Fraction of the cached rate card a refetch must retain to be adopted.
 *
 * The absolute floor above catches a 404 page or a truncated download, but not
 * a payload that is well-formed and catastrophically smaller — a partial
 * publish, a bad upstream migration, a CDN serving an old stub. Accepting one
 * would silently drop rates for thousands of models, and every one of them
 * would go back to reporting $0, which is precisely the failure this module
 * exists to prevent. Losing a quarter of the entries in one refresh is not a
 * normal day for a catalogue that only grows.
 */
export const MIN_RETAINED_FRACTION = 0.75;

/**
 * Reject a refetch that lost most of what we already had.
 *
 * Deliberately one-directional: growth is always fine, and a first sync with
 * nothing cached has nothing to compare against and is accepted.
 */
export function isSuspiciousShrink(previousEntries: number, nextEntries: number): boolean {
  if (previousEntries <= 0) return false;
  return nextEntries < previousEntries * MIN_RETAINED_FRACTION;
}

/** Never throws: a missing rate card is a reportable state, not a crash. */
export async function syncPriceBook(opts: PriceBookOptions): Promise<PriceBookResult> {
  const url = opts.url ?? DEFAULT_PRICE_BOOK_URL;
  const cached = readCache(opts.cacheDir);
  const cachedOk = cached && looksLikePriceBook(cached.payload) ? cached : null;

  const base = {
    source: LITELLM_SOURCE_ID,
    license: 'MIT',
    attribution:
      'Model rates and context windows from github.com/BerriAI/litellm (MIT), used and redistributed under its licence.',
  };

  const serveCache = (status: PriceBookStatus, error: string | null): PriceBookResult => {
    if (!cachedOk) {
      return {
        ...base,
        status: 'unavailable',
        book: null,
        entries: 0,
        fromCache: false,
        fetchedAt: null,
        cacheAgeDays: null,
        error: error ?? 'no cached price book and the network was unavailable',
      };
    }
    const book = new PriceBook(cachedOk.payload as Record<string, unknown>);
    return {
      ...base,
      status,
      book,
      entries: book.size,
      fromCache: true,
      fetchedAt: cachedOk.fetchedAt,
      cacheAgeDays: Math.max(0, Math.floor((opts.now - cachedOk.fetchedAt) / DAY_MS)),
      error,
    };
  };

  if (opts.offline) return serveCache('stale-cache', null);

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cachedOk?.etag) headers['if-none-match'] = cachedOk.etag;

    const res = await doFetch(url, { headers, signal: controller.signal });
    if (res.status === 304 && cachedOk) return serveCache('not-modified', null);
    if (!res.ok) return serveCache('stale-cache', `upstream returned HTTP ${res.status}`);

    const raw: unknown = await res.json();
    if (!looksLikePriceBook(raw)) {
      return serveCache('stale-cache', 'upstream payload did not look like the price book');
    }

    // A well-formed payload that lost most of its entries is more dangerous
    // than a malformed one, because nothing else would catch it. Keep the copy
    // we have and say why.
    const nextBook = new PriceBook(raw as Record<string, unknown>);
    if (cachedOk) {
      const previous = new PriceBook(cachedOk.payload as Record<string, unknown>).size;
      if (isSuspiciousShrink(previous, nextBook.size)) {
        return serveCache(
          'stale-cache',
          `refused a refetch that shrank from ${previous} to ${nextBook.size} entries; keeping the cached rate card`,
        );
      }
    }

    const p = priceBookCachePath(opts.cacheDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ etag: res.headers.get('etag'), fetchedAt: opts.now, url, payload: raw }), 'utf8');

    const book = nextBook;
    return {
      ...base,
      status: 'updated',
      book,
      entries: book.size,
      fromCache: false,
      fetchedAt: opts.now,
      cacheAgeDays: 0,
      error: null,
    };
  } catch (e) {
    return serveCache('stale-cache', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
