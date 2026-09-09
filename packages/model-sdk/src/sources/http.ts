/**
 * One HTTP client for every discovery source.
 *
 * Three sources had already grown their own fetch-and-cache, with the same
 * shape and slightly different behaviour, and a fourth was about to. What they
 * all need is the same, and none of it is interesting enough to reimplement:
 *
 *   - Read the cache first at boot, so a gateway starting with no network still
 *     knows what it knew yesterday.
 *   - Send the stored validators, so a 304 costs the upstream nothing. These
 *     are free, community-run repositories; polling them impolitely is how a
 *     free thing stops being free.
 *   - On failure, keep serving the last good payload **with its age attached**.
 *     Falling back silently is how stale data becomes wrong data.
 *   - Never overwrite a good cache with a bad payload. A 404 page parses as
 *     text, and "the file is now an HTML error page" must not become "the
 *     provider list is empty".
 *
 * The address guard applies here too. These URLs are configuration, and
 * configuration is user input: an operator who can set a dataset URL could
 * otherwise point the discovery engine at the cloud metadata service and read
 * the result back through the catalog UI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assessUrl } from '@meridian/shared';

const DAY_MS = 86_400_000;

export interface CacheEnvelope<T = unknown> {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  payload: T;
}

export type FetchOutcome =
  /** New payload, validated and cached. */
  | 'updated'
  /** Upstream said nothing changed; the cache is current. */
  | 'not-modified'
  /** The fetch failed; serving what was cached, which may be old. */
  | 'stale-cache'
  /** The fetch failed and there is no cache. */
  | 'unavailable';

export interface CachedFetchResult<T> {
  outcome: FetchOutcome;
  /** Null only when the outcome is 'unavailable'. */
  payload: T | null;
  fromCache: boolean;
  fetchedAt: number | null;
  cacheAgeDays: number | null;
  error: string | null;
  /** Bytes received on the wire, when a body was transferred. */
  bytes: number | null;
}

export interface CachedFetchOptions<T> {
  url: string;
  cacheDir: string;
  /** File name inside cacheDir. Source ids are used, so one file per source. */
  cacheKey: string;
  now: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Read the cache and never touch the network. Used at boot. */
  offline?: boolean;
  headers?: Record<string, string>;
  /**
   * Decide whether a freshly downloaded payload is the thing that was asked
   * for. Returning false keeps the previous cache and reports the failure —
   * which is the behaviour that matters, because the common upstream failure is
   * not a 500 but a 200 carrying something else.
   */
  validate: (raw: unknown) => raw is T;
  /** What to say when validation fails. Shown to the operator. */
  describeInvalid?: (raw: unknown) => string;
}

export function cacheFilePath(cacheDir: string, cacheKey: string): string {
  return join(cacheDir, `${cacheKey}.json`);
}

export function readCacheEnvelope<T>(cacheDir: string, cacheKey: string): CacheEnvelope<T> | null {
  const path = cacheFilePath(cacheDir, cacheKey);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheEnvelope<T>;
    if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null;
    return parsed;
  } catch {
    // A truncated or hand-edited cache file is a missing cache, not a crash.
    return null;
  }
}

function writeCacheEnvelope<T>(cacheDir: string, cacheKey: string, envelope: CacheEnvelope<T>): void {
  const path = cacheFilePath(cacheDir, cacheKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(envelope));
}

function ageDays(fetchedAt: number | null, now: number): number | null {
  if (fetchedAt === null) return null;
  return Math.max(0, Math.floor((now - fetchedAt) / DAY_MS));
}

function served<T>(
  cached: CacheEnvelope<T> | null,
  now: number,
  outcome: FetchOutcome,
  error: string | null,
): CachedFetchResult<T> {
  if (!cached) {
    return { outcome: 'unavailable', payload: null, fromCache: false, fetchedAt: null, cacheAgeDays: null, error, bytes: null };
  }
  return {
    outcome,
    payload: cached.payload,
    fromCache: true,
    fetchedAt: cached.fetchedAt,
    cacheAgeDays: ageDays(cached.fetchedAt, now),
    error,
    bytes: null,
  };
}

/**
 * Fetch a JSON document, validate it, and cache it — or keep what was cached.
 *
 * Never throws. An unreachable source is a state to report, not an exception
 * that takes down a gateway boot, and the whole point of the cache is that the
 * product keeps working when the network does not.
 */
export async function fetchJsonCached<T>(opts: CachedFetchOptions<T>): Promise<CachedFetchResult<T>> {
  const cached = readCacheEnvelope<T>(opts.cacheDir, opts.cacheKey);

  if (opts.offline) {
    return cached
      ? served(cached, opts.now, 'stale-cache', null)
      : served(null, opts.now, 'unavailable', 'Offline, and nothing is cached yet.');
  }

  const verdict = assessUrl(opts.url);
  if (!verdict.ok) {
    return served(cached, opts.now, cached ? 'stale-cache' : 'unavailable', `Refusing to fetch ${opts.url}: ${verdict.message}`);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'Meridian/1.0 (+https://github.com/jyoung2000/Gdg)',
      ...opts.headers,
    };
    // Only send validators when there is something to validate against —
    // otherwise a 304 would leave nothing to serve.
    if (cached?.url === opts.url) {
      if (cached.etag) headers['if-none-match'] = cached.etag;
      if (cached.lastModified) headers['if-modified-since'] = cached.lastModified;
    }

    const response = await doFetch(opts.url, { headers, signal: controller.signal, redirect: 'follow' });

    if (response.status === 304 && cached) {
      // Upstream confirmed the payload; the cache is current, not stale, so its
      // fetch time moves forward. Reporting a confirmed payload as three weeks
      // old would be as misleading as reporting a stale one as fresh.
      const refreshed: CacheEnvelope<T> = { ...cached, fetchedAt: opts.now };
      writeCacheEnvelope(opts.cacheDir, opts.cacheKey, refreshed);
      return { outcome: 'not-modified', payload: cached.payload, fromCache: true, fetchedAt: opts.now, cacheAgeDays: 0, error: null, bytes: null };
    }

    if (!response.ok) {
      return served(cached, opts.now, cached ? 'stale-cache' : 'unavailable', `${opts.url} returned ${response.status}.`);
    }

    const text = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return served(cached, opts.now, cached ? 'stale-cache' : 'unavailable', `${opts.url} did not return JSON (${text.length} bytes).`);
    }

    if (!opts.validate(raw)) {
      const why = opts.describeInvalid?.(raw) ?? 'the payload is not the document this source expects';
      return served(cached, opts.now, cached ? 'stale-cache' : 'unavailable', `Rejected the payload from ${opts.url}: ${why}.`);
    }

    const envelope: CacheEnvelope<T> = {
      url: opts.url,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      fetchedAt: opts.now,
      payload: raw,
    };
    writeCacheEnvelope(opts.cacheDir, opts.cacheKey, envelope);
    return { outcome: 'updated', payload: raw, fromCache: false, fetchedAt: opts.now, cacheAgeDays: 0, error: null, bytes: text.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = controller.signal.aborted ? `timed out after ${opts.timeoutMs ?? 20_000}ms` : message;
    return served(cached, opts.now, cached ? 'stale-cache' : 'unavailable', `Could not fetch ${opts.url}: ${detail}.`);
  } finally {
    clearTimeout(timer);
  }
}
