import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFreeAccess,
  diffDatasets,
  needsOperatorConfig,
  normalizeDataset,
  normalizeEntry,
  parseDataset,
  pricingForAccess,
  requirementsFor,
  syncFreeLlmHub,
  cachePath,
  type FreeLlmHubDataset,
} from '@meridian/model-sdk';
import {
  freeAccessLabel,
  isZeroCost,
  isStale,
  provenanceAgeDays,
  quotaRemainingFraction,
  tristate,
  type QuotaState,
} from '@meridian/shared';

/**
 * Model intelligence: classification, provenance and synchronisation.
 *
 * The tests that matter most here are the negative ones. It is easy to write a
 * catalogue that says "free" and "no card required"; the whole value of this
 * subsystem is that it declines to say either when it does not know, so most of
 * what follows pins down what Meridian must NOT claim.
 */

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'example',
  name: 'Example',
  category: 'ongoing',
  free_type: 'renewing-quota',
  free_tier: 'Some models',
  rate_limits: '10 RPM / 250 RPD',
  docs_url: 'https://example.com/docs',
  verified: true,
  last_verified: '2026-08-01',
  ...over,
});

const dataset = (providers: Record<string, unknown>[]): FreeLlmHubDataset =>
  parseDataset({ version: '1.0.0', generated: '2026-08-14', providers });

const OPTS = { now: Date.parse('2026-08-20T00:00:00Z'), existingIds: new Set<string>() };

describe('free-tier classification', () => {
  it('separates a renewing quota from a one-off trial credit', () => {
    assert.equal(classifyFreeAccess(entry({ free_type: 'perpetual' }) as never), 'FREE_FOREVER');
    assert.equal(classifyFreeAccess(entry({ free_type: 'trial-credit' }) as never), 'TRIAL_CREDIT');
    assert.equal(classifyFreeAccess(entry({ free_type: 'recurring-credit' }) as never), 'RECURRING_CREDIT');
  });

  it('reads the renewal period from the published limits rather than assuming one', () => {
    assert.equal(
      classifyFreeAccess(entry({ rate_limits: '5 RPM / 100 RPD' }) as never),
      'FREE_DAILY_QUOTA',
    );
    assert.equal(
      classifyFreeAccess(entry({ rate_limits: '1,000 requests per month' }) as never),
      'FREE_MONTHLY_QUOTA',
    );
    // No period stated anywhere: stays generic instead of guessing "daily",
    // which would misreport a monthly allowance by a factor of thirty.
    assert.equal(
      classifyFreeAccess(entry({ rate_limits: 'generous', free_tier: 'lots' }) as never),
      'ONGOING_FREE_TIER',
    );
  });

  it('never counts spending a finite balance as costing nothing', () => {
    assert.equal(isZeroCost('TRIAL_CREDIT'), false);
    assert.equal(isZeroCost('RECURRING_CREDIT'), false);
    assert.equal(isZeroCost('SUBSCRIPTION_INCLUDED'), false);
    assert.equal(isZeroCost('DISCOUNTED'), false);
    assert.equal(isZeroCost('UNKNOWN'), false);
    assert.equal(isZeroCost('FREE_FOREVER'), true);
    assert.equal(isZeroCost('LOCAL_ZERO_API_COST'), true);
  });

  it('labels a rate-limited allowance as a quota, never as plain FREE', () => {
    // The catalog's standing rule: conflating the two is the mislabelling the
    // product forbids.
    assert.equal(pricingForAccess('FREE_DAILY_QUOTA', null).kind, 'FREE_DAILY');
    assert.equal(pricingForAccess('ONGOING_FREE_TIER', null).kind, 'FREE_DAILY');
    assert.equal(pricingForAccess('FREE_FOREVER', null).kind, 'FREE');
    assert.equal(pricingForAccess('TRIAL_CREDIT', null).kind, 'TRIAL');
  });

  it('invents no rates', () => {
    const p = pricingForAccess('FREE_DAILY_QUOTA', '10 RPM');
    assert.equal(p.inputPerMTok, null);
    assert.equal(p.outputPerMTok, null);
    assert.equal(p.perRequest, null);
  });

  it('gives every access kind a label', () => {
    for (const k of ['FREE_FOREVER', 'TRIAL_CREDIT', 'UNKNOWN'] as const) {
      assert.ok(freeAccessLabel(k).length > 0);
    }
  });
});

describe('tri-state honesty', () => {
  it('maps upstream null to unknown, not to false', () => {
    assert.equal(tristate(true), 'yes');
    assert.equal(tristate(false), 'no');
    assert.equal(tristate(null), 'unknown');
    assert.equal(tristate(undefined), 'unknown');
  });

  it('keeps an unconfirmed card requirement unknown', () => {
    const r = requirementsFor(entry({ card_required: null, phone_required: null }) as never);
    assert.equal(r.card, 'unknown');
    assert.equal(r.phone, 'unknown');
    // Crucially NOT 'no': a "no card required" filter must not match this.
    assert.notEqual(r.card, 'no');
  });

  it('carries a known requirement through unchanged', () => {
    const r = requirementsFor(entry({ card_required: true, phone_required: false }) as never);
    assert.equal(r.card, 'yes');
    assert.equal(r.phone, 'no');
  });
});

describe('normalisation into routable providers', () => {
  it('produces a callable descriptor from an OpenAI-compatible entry', () => {
    const d = dataset([
      entry({ slug: 'acme', openai_compatible: true, openai_base_url: 'https://api.acme.test/v1', env_key: 'ACME_KEY' }),
    ]);
    const n = normalizeEntry(d.providers[0]!, d, OPTS);
    assert.ok(n.descriptor, 'should be routable');
    assert.equal(n.descriptor?.adapter, 'openai-compatible');
    assert.equal(n.descriptor?.baseUrl, 'https://api.acme.test/v1');
    assert.deepEqual(n.descriptor?.envKeys, ['ACME_KEY']);
    assert.equal(n.descriptor?.auth, 'api-key');
    // Imported, therefore not vetted here.
    assert.equal(n.descriptor?.trust, 'unknown');
  });

  it('refuses to route an entry with no OpenAI-compatible endpoint', () => {
    const d = dataset([entry({ slug: 'native-only', openai_compatible: false })]);
    const n = normalizeEntry(d.providers[0]!, d, OPTS);
    assert.equal(n.descriptor, null);
    assert.equal(n.unroutableReason, 'no-openai-compatible-endpoint');
    // It still contributes what it knows.
    assert.ok(n.intelligence.freeTierSummary);
  });

  it('refuses to route a base URL the operator still has to fill in', () => {
    assert.equal(needsOperatorConfig('https://api.x/accounts/{account_id}/v1'), true);
    assert.equal(needsOperatorConfig('https://api.x/v1'), false);
    const d = dataset([
      entry({ slug: 'templated', openai_compatible: true, openai_base_url: 'https://api.x/{account_id}/v1' }),
    ]);
    const n = normalizeEntry(d.providers[0]!, d, OPTS);
    assert.equal(n.descriptor, null, 'a templated URL is not a working endpoint');
    assert.equal(n.unroutableReason, 'base-url-needs-operator-substitution');
  });

  it('enriches a shipped provider instead of overwriting it', () => {
    const d = dataset([
      entry({ slug: 'groq', openai_compatible: true, openai_base_url: 'https://api.groq.test/v1' }),
    ]);
    const n = normalizeEntry(d.providers[0]!, d, { ...OPTS, existingIds: new Set(['groq']) });
    assert.equal(n.descriptor, null, 'the hand-written descriptor must win');
    assert.equal(n.unroutableReason, 'already-shipped');
    assert.equal(n.intelligence.providerId, 'groq');
  });

  it('records provenance rather than claiming Meridian verified anything', () => {
    const d = dataset([entry({ slug: 'acme', verified: true, last_verified: '2026-08-01' })]);
    const n = normalizeEntry(d.providers[0]!, d, OPTS);
    const p = n.intelligence.provenance;
    assert.equal(p.source, 'free-llm-api-hub');
    assert.equal(p.sourceType, 'dataset');
    assert.equal(p.sourceVersion, '1.0.0');
    assert.equal(p.sourceVerified, true);
    assert.equal(p.lastVerified, '2026-08-01');
    // A third party's reading of the docs on a past date is never "high".
    assert.equal(p.confidence, 'medium');
  });

  it('drops confidence for an unverified entry', () => {
    const d = dataset([entry({ slug: 'acme', verified: false, last_verified: null })]);
    const n = normalizeEntry(d.providers[0]!, d, OPTS);
    assert.equal(n.intelligence.provenance.confidence, 'low');
  });
});

describe('provenance freshness', () => {
  const base = {
    source: 's', sourceType: 'dataset' as const, sourceUrl: null, sourceVersion: null,
    sourceVerified: true, verificationMethod: null, confidence: 'medium' as const, importedAt: 0,
  };

  it('measures age in days', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    assert.equal(provenanceAgeDays({ ...base, lastVerified: '2026-08-10' }, now), 10);
  });

  it('treats an undated claim as stale rather than fresh', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    assert.equal(provenanceAgeDays({ ...base, lastVerified: null }, now), null);
    assert.equal(isStale({ ...base, lastVerified: null }, now), true);
  });

  it('marks a long-unchecked claim stale', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    assert.equal(isStale({ ...base, lastVerified: '2026-08-19' }, now), false);
    assert.equal(isStale({ ...base, lastVerified: '2025-01-01' }, now), true);
  });
});

describe('quota state', () => {
  const q = (over: Partial<QuotaState>): QuotaState => ({
    providerId: 'p', modelId: null, requestsUsed: null, requestsLimit: null,
    tokensUsed: null, tokensLimit: null, resetsAt: null, source: 'unknown', updatedAt: 0, ...over,
  });

  it('returns null when the provider publishes nothing', () => {
    // Not 1. "We don't know" and "it's full" must not be the same value, or a
    // free-first router keeps choosing a route that is already exhausted.
    assert.equal(quotaRemainingFraction(q({})), null);
  });

  it('computes the remaining fraction when limits are known', () => {
    const near = (actual: number | null, expected: number): void => {
      assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
    };
    near(quotaRemainingFraction(q({ requestsUsed: 25, requestsLimit: 100 })), 0.75);
    near(quotaRemainingFraction(q({ tokensUsed: 900, tokensLimit: 1000 })), 0.1);
    // Exhaustion is the one value that must be exact: it gates routing.
    assert.equal(quotaRemainingFraction(q({ requestsUsed: 100, requestsLimit: 100 })), 0);
  });
});

describe('change detection', () => {
  it('reports nothing on a first sync', () => {
    assert.deepEqual(diffDatasets(null, dataset([entry()])), []);
  });

  it('flags a provider appearing and disappearing', () => {
    const before = dataset([entry({ slug: 'a' })]);
    const after = dataset([entry({ slug: 'b' })]);
    const kinds = diffDatasets(before, after).map((c) => c.kind).sort();
    assert.deepEqual(kinds, ['provider-added', 'provider-removed']);
  });

  it('flags the changes that decide whether someone can use a provider', () => {
    const before = dataset([entry({ slug: 'a', card_required: false, commercial_ok: true })]);
    const after = dataset([entry({ slug: 'a', card_required: true, commercial_ok: false })]);
    const changes = diffDatasets(before, after);
    const kinds = changes.map((c) => c.kind);
    assert.ok(kinds.includes('card-requirement-changed'));
    assert.ok(kinds.includes('commercial-use-changed'));
    assert.ok(changes.every((c) => c.significant), 'both are consequential');
  });

  it('does not treat a reworded limits string as consequential', () => {
    const before = dataset([entry({ slug: 'a', rate_limits: '10 RPM' })]);
    const after = dataset([entry({ slug: 'a', rate_limits: '10 requests/minute' })]);
    const changes = diffDatasets(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.significant, false);
  });
});

describe('synchronisation', () => {
  const payload = {
    version: '2.0.0',
    generated: '2026-08-14',
    providers: [
      entry({ slug: 'acme', openai_compatible: true, openai_base_url: 'https://api.acme.test/v1', env_key: 'ACME_KEY' }),
      entry({ slug: 'native', openai_compatible: false }),
    ],
  };

  const okFetch = (body: unknown, etag = 'v1'): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', etag },
      })) as unknown as typeof fetch;

  const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-sync-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('fetches, validates and normalises', async () => {
    await withDir(async (dir) => {
      const r = await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: okFetch(payload) });
      assert.equal(r.status, 'updated');
      assert.equal(r.version, '2.0.0');
      assert.equal(r.dataset?.routable, 1);
      assert.equal(r.fromCache, false);
      assert.ok(existsSync(cachePath(dir)), 'writes a cache for the next boot');
    });
  });

  it('revalidates with the stored ETag and accepts a 304', async () => {
    await withDir(async (dir) => {
      await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: okFetch(payload, 'abc') });
      let sentIfNoneMatch: string | null = null;
      const notModified = (async (_u: string, init: RequestInit) => {
        sentIfNoneMatch = (init.headers as Record<string, string>)['if-none-match'] ?? null;
        return new Response(null, { status: 304 });
      }) as unknown as typeof fetch;

      const r = await syncFreeLlmHub({ cacheDir: dir, now: 2000, fetchImpl: notModified });
      assert.equal(sentIfNoneMatch, 'abc', 'must revalidate rather than re-download');
      assert.equal(r.status, 'not-modified');
      assert.equal(r.dataset?.providers.length, 2, 'still serves the catalog');
    });
  });

  it('keeps serving the last good catalog when the network fails', async () => {
    await withDir(async (dir) => {
      await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: okFetch(payload) });
      const down = (async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch;

      const r = await syncFreeLlmHub({ cacheDir: dir, now: 1000 + 3 * 86_400_000, fetchImpl: down });
      assert.equal(r.status, 'stale-cache');
      assert.equal(r.dataset?.providers.length, 2, 'a gateway must not lose its catalog offline');
      assert.equal(r.fromCache, true);
      assert.equal(r.cacheAgeDays, 3, 'and must say how old it is');
      assert.match(r.error ?? '', /ENOTFOUND/);
    });
  });

  it('does not let a malformed upstream payload destroy the good cache', async () => {
    await withDir(async (dir) => {
      await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: okFetch(payload) });
      const before = readFileSync(cachePath(dir), 'utf8');

      const garbage = okFetch({ version: 'not-semver', providers: [] });
      const r = await syncFreeLlmHub({ cacheDir: dir, now: 2000, fetchImpl: garbage });

      assert.equal(r.status, 'stale-cache');
      assert.equal(r.dataset?.providers.length, 2);
      assert.equal(readFileSync(cachePath(dir), 'utf8'), before, 'cache must be untouched');
    });
  });

  it('reports unavailable rather than inventing providers when it has nothing', async () => {
    await withDir(async (dir) => {
      const down = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const r = await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: down });
      assert.equal(r.status, 'unavailable');
      assert.equal(r.dataset, null);
    });
  });

  it('reads only the cache in offline mode and never calls the network', async () => {
    await withDir(async (dir) => {
      await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: okFetch(payload) });
      let called = false;
      const spy = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;

      const r = await syncFreeLlmHub({ cacheDir: dir, now: 1000, fetchImpl: spy, offline: true });
      assert.equal(called, false, 'boot must not wait on a third-party host');
      assert.equal(r.dataset?.providers.length, 2);
    });
  });

  it('rejects a payload that is not this dataset', async () => {
    assert.throws(() => parseDataset({ hello: 'world' }), /failed validation/);
    assert.throws(() => parseDataset({ version: '1.0.0', generated: 'x', providers: [] }), /failed validation/);
  });

  it('survives an upstream that adds new fields', () => {
    // Forward compatibility: a new upstream column must not strand the
    // operator on stale data.
    const d = dataset([entry({ slug: 'acme', brand_new_field: 'surprise' })]);
    assert.equal(d.providers.length, 1);
  });

  it('counts routable, enriched and unroutable entries', () => {
    const d = dataset([
      entry({ slug: 'acme', openai_compatible: true, openai_base_url: 'https://a.test/v1' }),
      entry({ slug: 'groq', openai_compatible: true, openai_base_url: 'https://g.test/v1' }),
      entry({ slug: 'native', openai_compatible: false }),
    ]);
    const n = normalizeDataset(d, { now: 0, existingIds: new Set(['groq']) });
    assert.equal(n.routable, 1);
    assert.equal(n.enrichedExisting, 1);
    assert.equal(n.unroutable['no-openai-compatible-endpoint'], 1);
  });
});
