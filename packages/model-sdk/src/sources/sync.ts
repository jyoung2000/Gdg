/**
 * Dataset synchronisation: fetch, validate, cache, and say what changed.
 *
 * The behaviour that matters here is what happens when the network is not
 * there. A model gateway that blanks its provider list because GitHub was
 * unreachable is worse than useless, so a failed sync always falls back to the
 * last good payload on disk and reports its age. The one thing this module
 * will never do is present stale data as current: `fromCache` and
 * `cacheAgeDays` travel with the result so the UI can label it.
 *
 * It is also a polite client. Upstream is a free, community-run repository, so
 * every request carries the stored ETag and a 304 costs nobody anything.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DATASET_URL,
  normalizeDataset,
  parseDataset,
  SOURCE_ID,
  type FreeLlmHubDataset,
  type NormalizedDataset,
} from './free-llm-api-hub.js';

/* ------------------------------------------------------------------ */
/* Change detection                                                    */
/* ------------------------------------------------------------------ */

export const DATASET_CHANGE_KINDS = [
  'provider-added',
  'provider-removed',
  'free-access-changed',
  'free-tier-changed',
  'rate-limits-changed',
  'card-requirement-changed',
  'phone-requirement-changed',
  'commercial-use-changed',
  'endpoint-changed',
  'free-models-changed',
  'verification-changed',
] as const;
export type DatasetChangeKind = (typeof DATASET_CHANGE_KINDS)[number];

export interface DatasetChange {
  kind: DatasetChangeKind;
  providerId: string;
  providerName: string;
  before: string | null;
  after: string | null;
  /**
   * Does this change matter to someone relying on the provider?
   *
   * A free tier disappearing or a card requirement appearing changes whether
   * the operator can use it at all; a reworded note does not.
   */
  significant: boolean;
}

const show = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
};

/**
 * Diff two dataset versions.
 *
 * Deliberately field-by-field rather than a deep object diff: the point is to
 * produce changes a person would want to read ("Groq now requires a card"),
 * not a JSON patch.
 */
export function diffDatasets(
  before: FreeLlmHubDataset | null,
  after: FreeLlmHubDataset,
): DatasetChange[] {
  if (!before) return [];
  const changes: DatasetChange[] = [];
  const prev = new Map(before.providers.map((p) => [p.slug, p]));
  const next = new Map(after.providers.map((p) => [p.slug, p]));

  for (const [slug, p] of next) {
    if (!prev.has(slug)) {
      changes.push({
        kind: 'provider-added',
        providerId: slug,
        providerName: p.name,
        before: null,
        after: p.free_tier,
        significant: true,
      });
    }
  }
  for (const [slug, p] of prev) {
    if (!next.has(slug)) {
      changes.push({
        kind: 'provider-removed',
        providerId: slug,
        providerName: p.name,
        before: p.free_tier,
        after: null,
        significant: true,
      });
    }
  }

  const watched: { kind: DatasetChangeKind; field: string; significant: boolean }[] = [
    { kind: 'free-access-changed', field: 'free_type', significant: true },
    { kind: 'free-tier-changed', field: 'free_tier', significant: true },
    { kind: 'rate-limits-changed', field: 'rate_limits', significant: false },
    { kind: 'card-requirement-changed', field: 'card_required', significant: true },
    { kind: 'phone-requirement-changed', field: 'phone_required', significant: true },
    { kind: 'commercial-use-changed', field: 'commercial_ok', significant: true },
    { kind: 'endpoint-changed', field: 'openai_base_url', significant: true },
    { kind: 'free-models-changed', field: 'models_free', significant: false },
    { kind: 'verification-changed', field: 'verified', significant: false },
  ];

  for (const [slug, now] of next) {
    const was = prev.get(slug);
    if (!was) continue;
    for (const w of watched) {
      const a = show((was as Record<string, unknown>)[w.field]);
      const b = show((now as Record<string, unknown>)[w.field]);
      if (a !== b) {
        changes.push({
          kind: w.kind,
          providerId: slug,
          providerName: now.name,
          before: a,
          after: b,
          significant: w.significant,
        });
      }
    }
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

interface CacheEnvelope {
  etag: string | null;
  fetchedAt: number;
  url: string;
  payload: unknown;
}

export function cachePath(cacheDir: string): string {
  return join(cacheDir, `${SOURCE_ID}.json`);
}

function readCache(cacheDir: string): CacheEnvelope | null {
  const p = cachePath(cacheDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CacheEnvelope;
  } catch {
    // A corrupt cache is not fatal; it just means there is no fallback.
    return null;
  }
}

function writeCache(cacheDir: string, env: CacheEnvelope): void {
  const p = cachePath(cacheDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(env), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export type SyncStatus =
  /** Fetched a new payload and it validated. */
  | 'updated'
  /** Upstream said 304; the cached payload is still current. */
  | 'not-modified'
  /** Network or validation failed; serving the last good payload. */
  | 'stale-cache'
  /** Nothing fetched and nothing cached. */
  | 'unavailable';

export interface SyncOptions {
  cacheDir: string;
  now: number;
  url?: string;
  timeoutMs?: number;
  /** Injected in tests, and to let the gateway supply a traced fetch. */
  fetchImpl?: typeof fetch;
  /** Providers Meridian already ships, so imports enrich rather than duplicate. */
  existingIds?: ReadonlySet<string>;
  /** Skip the network entirely and use whatever is cached. */
  offline?: boolean;
}

export interface SyncResult {
  status: SyncStatus;
  source: string;
  /** Null only when status is 'unavailable'. */
  dataset: NormalizedDataset | null;
  version: string | null;
  generated: string | null;
  fromCache: boolean;
  fetchedAt: number | null;
  /** Whole days since the payload being served was fetched. */
  cacheAgeDays: number | null;
  changes: DatasetChange[];
  error: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Fetch (or reuse) the dataset and normalise it.
 *
 * Never throws: a sync failure is a reportable state, not an exception that
 * takes down a gateway boot.
 */
export async function syncFreeLlmHub(opts: SyncOptions): Promise<SyncResult> {
  const url = opts.url ?? DEFAULT_DATASET_URL;
  const existingIds = opts.existingIds ?? new Set<string>();
  const cached = readCache(opts.cacheDir);
  const cachedDataset = cached ? safeParse(cached.payload) : null;

  const serveCache = (status: SyncStatus, error: string | null): SyncResult => {
    if (!cachedDataset || !cached) {
      return {
        status: 'unavailable',
        source: SOURCE_ID,
        dataset: null,
        version: null,
        generated: null,
        fromCache: false,
        fetchedAt: null,
        cacheAgeDays: null,
        changes: [],
        error: error ?? 'no cached dataset and the network was unavailable',
      };
    }
    return {
      status,
      source: SOURCE_ID,
      dataset: normalizeDataset(cachedDataset, { now: opts.now, existingIds }),
      version: cachedDataset.version,
      generated: cachedDataset.generated,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
      cacheAgeDays: Math.max(0, Math.floor((opts.now - cached.fetchedAt) / DAY_MS)),
      changes: [],
      error,
    };
  };

  if (opts.offline) return serveCache('stale-cache', null);

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Politeness: a 304 costs upstream almost nothing.
    if (cached?.etag && cachedDataset) headers['if-none-match'] = cached.etag;

    const res = await doFetch(url, { headers, signal: controller.signal });

    if (res.status === 304 && cachedDataset && cached) {
      return {
        status: 'not-modified',
        source: SOURCE_ID,
        dataset: normalizeDataset(cachedDataset, { now: opts.now, existingIds }),
        version: cachedDataset.version,
        generated: cachedDataset.generated,
        fromCache: true,
        fetchedAt: cached.fetchedAt,
        cacheAgeDays: Math.max(0, Math.floor((opts.now - cached.fetchedAt) / DAY_MS)),
        changes: [],
        error: null,
      };
    }

    if (!res.ok) return serveCache('stale-cache', `upstream returned HTTP ${res.status}`);

    const raw: unknown = await res.json();
    // Validate BEFORE replacing the cache: a malformed upstream payload must
    // not destroy the last known good copy.
    const parsed = parseDataset(raw);
    const changes = diffDatasets(cachedDataset, parsed);

    writeCache(opts.cacheDir, {
      etag: res.headers.get('etag'),
      fetchedAt: opts.now,
      url,
      payload: raw,
    });

    return {
      status: 'updated',
      source: SOURCE_ID,
      dataset: normalizeDataset(parsed, { now: opts.now, existingIds }),
      version: parsed.version,
      generated: parsed.generated,
      fromCache: false,
      fetchedAt: opts.now,
      cacheAgeDays: 0,
      changes,
      error: null,
    };
  } catch (e) {
    return serveCache('stale-cache', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(raw: unknown): FreeLlmHubDataset | null {
  try {
    return parseDataset(raw);
  } catch {
    return null;
  }
}
