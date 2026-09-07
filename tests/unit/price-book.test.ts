import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PriceBook,
  PROVIDER_ALIASES,
  looksLikePriceBook,
  perMTok,
  priceBookCachePath,
  syncPriceBook,
  toPricing,
  MNFST_METADATA,
  UZAIR_METADATA,
  freeQuotaOf,
  mnfstSchema,
  namedModels,
  parseRateLimitText,
  parseTokenCount,
  uzairIntelligence,
  uzairProviderSchema,
  ageAdjusted,
  confidenceRank,
  sourceRank,
  strongerConfidence,
} from '@meridian/model-sdk';
import { computeCost, isFree, type Pricing } from '@meridian/shared';

/**
 * The price book: rates for providers whose rates Meridian otherwise guessed at.
 *
 * The bug this closes is that every catalog price was null, so `computeCost`
 * returned 0 for every paid provider and budget caps could not bind on spend
 * that always computed to zero. The tests therefore care about two things: that
 * real rates arrive, and that a rate is never borrowed from the wrong provider.
 */

/** A minimal upstream-shaped payload. */
const book = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'gpt-4o': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    supports_vision: true,
    supports_function_calling: true,
  },
  'groq/llama-3.3-70b-versatile': {
    litellm_provider: 'groq',
    mode: 'chat',
    input_cost_per_token: 0.00000059,
    output_cost_per_token: 0.00000079,
    max_input_tokens: 131072,
  },
  'some-free-model': {
    litellm_provider: 'groq',
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
  'context-only': { litellm_provider: 'openai', max_input_tokens: 8192 },
  ...over,
});

describe('rate conversion', () => {
  it('converts per-token rates to per-million', () => {
    assert.equal(perMTok(0.0000025), 2.5);
    assert.equal(perMTok(0.00001), 10);
    assert.equal(perMTok(0), 0);
  });

  it('returns null for anything that is not a usable rate', () => {
    assert.equal(perMTok(undefined), null);
    assert.equal(perMTok(Number.NaN), null);
    assert.equal(perMTok(-1), null, 'a negative rate is not a discount, it is bad data');
  });

  it('maps an all-zero entry to FREE and a rateless entry to null', () => {
    assert.equal(toPricing({ input_cost_per_token: 0, output_cost_per_token: 0 })?.kind, 'FREE');
    assert.equal(toPricing({ max_tokens: 100 }), null, 'no rates means no opinion on price');
  });
});

describe('lookup', () => {
  const b = new PriceBook(book());

  it('finds an exact model id for the right provider', () => {
    const f = b.lookup('openai', 'gpt-4o');
    assert.ok(f);
    assert.equal(f.pricing.inputPerMTok, 2.5);
    assert.equal(f.pricing.outputPerMTok, 10);
    assert.equal(f.contextLength, 128000);
    assert.equal(f.matchKind, 'exact');
  });

  it('finds a provider-qualified key', () => {
    const f = b.lookup('groq', 'llama-3.3-70b-versatile');
    assert.ok(f);
    assert.equal(f.pricing.inputPerMTok, 0.59);
    assert.equal(f.matchKind, 'provider-qualified');
  });

  it('carries capability flags through', () => {
    assert.deepEqual(b.lookup('openai', 'gpt-4o')?.capabilities, { vision: true, tools: true });
  });

  it('NEVER borrows one provider’s rate for another', () => {
    // The single most important property here. The same model id served by a
    // different host costs a different amount, and quietly attaching OpenAI's
    // rate card to Groq's bill is exactly the confident wrong number this
    // subsystem exists to avoid.
    assert.equal(b.lookup('groq', 'gpt-4o'), null);
    assert.equal(b.lookup('anthropic', 'gpt-4o'), null);
  });

  it('declines to price a provider it has no mapping for', () => {
    // No alias mapping means we cannot confirm an entry is about this
    // provider, so an id collision must not become a price.
    assert.equal(b.lookup('some-unknown-host', 'gpt-4o'), null);
    assert.equal(PROVIDER_ALIASES['some-unknown-host'], undefined);
  });

  it('leaves OpenRouter to publish its own rates', () => {
    // Absent from the alias map on purpose: OpenRouter serves real per-model
    // rates in its own listing and a third-party book must not shadow them.
    assert.equal(PROVIDER_ALIASES.openrouter, undefined);
    assert.equal(new PriceBook(book({ 'openrouter/x': { litellm_provider: 'openrouter', input_cost_per_token: 1 } })).lookup('openrouter', 'x'), null);
  });

  it('still reports limits for an entry with no rates', () => {
    const f = b.lookup('openai', 'context-only');
    assert.ok(f);
    assert.equal(f.contextLength, 8192);
    assert.equal(f.pricing.kind, 'UNKNOWN', 'no rates stays unknown, not zero');
  });
});

describe('cost accounting', () => {
  const POSTURE: Pricing = { kind: 'METERED', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };

  it('was reporting zero for paid models, and now does not', () => {
    assert.equal(computeCost(POSTURE, 1_000_000, 1_000_000, 0), 0, 'the bug: a posture with no rates costs nothing');

    const priced = new PriceBook(book()).lookup('openai', 'gpt-4o')!.pricing;
    assert.equal(computeCost(priced, 1_000_000, 1_000_000, 0), 12.5, '2.5 in + 10 out');
  });

  it('does not treat an unpriced metered model as free', () => {
    // The free gate was already sound; only accounting was broken. Pinned here
    // so a future change cannot quietly make unknown mean free.
    assert.equal(isFree(POSTURE), false);
    assert.equal(isFree({ ...POSTURE, inputPerMTok: 0, outputPerMTok: 0 }), true);
  });
});

describe('payload validation', () => {
  it('accepts a real-shaped book and rejects everything else', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) big[`m${i}`] = { litellm_provider: 'openai', input_cost_per_token: 1e-6 };
    assert.equal(looksLikePriceBook(big), true);

    assert.equal(looksLikePriceBook({ detail: 'Not Found' }), false, 'a 404 body is not a rate card');
    assert.equal(looksLikePriceBook(null), false);
    assert.equal(looksLikePriceBook([]), false);
    assert.equal(looksLikePriceBook(book()), false, 'a handful of entries is a truncated download');
  });
});

describe('sync', () => {
  const many = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) o[`model-${i}`] = { litellm_provider: 'openai', input_cost_per_token: 1e-6 };
    o['gpt-4o'] = { litellm_provider: 'openai', input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 };
    return o;
  };

  const ok = (body: unknown, etag = 'v1'): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag } })) as unknown as typeof fetch;

  const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('fetches and indexes', async () => {
    await withDir(async (dir) => {
      const r = await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: ok(many()) });
      assert.equal(r.status, 'updated');
      assert.ok(r.entries >= 200);
      assert.equal(r.book?.lookup('openai', 'gpt-4o')?.pricing.inputPerMTok, 2.5);
      assert.ok(existsSync(priceBookCachePath(dir)));
    });
  });

  it('revalidates with an ETag', async () => {
    await withDir(async (dir) => {
      await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: ok(many(), 'abc') });
      let sent: string | null = null;
      const notModified = (async (_u: string, init: RequestInit) => {
        sent = (init.headers as Record<string, string>)['if-none-match'] ?? null;
        return new Response(null, { status: 304 });
      }) as unknown as typeof fetch;
      const r = await syncPriceBook({ cacheDir: dir, now: 2000, fetchImpl: notModified });
      assert.equal(sent, 'abc', 'a 2.3MB payload must not be re-downloaded needlessly');
      assert.equal(r.status, 'not-modified');
      assert.ok(r.entries >= 200);
    });
  });

  it('keeps the rate card when the network fails', async () => {
    await withDir(async (dir) => {
      await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: ok(many()) });
      const down = (async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch;
      const r = await syncPriceBook({ cacheDir: dir, now: 1000 + 2 * 86_400_000, fetchImpl: down });
      assert.equal(r.status, 'stale-cache');
      assert.ok(r.entries >= 200, 'losing the rate card would mean reporting $0 again');
      assert.equal(r.cacheAgeDays, 2);
    });
  });

  it('does not let a 404 body replace a good rate card', async () => {
    await withDir(async (dir) => {
      await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: ok(many()) });
      const before = readFileSync(priceBookCachePath(dir), 'utf8');
      const r = await syncPriceBook({ cacheDir: dir, now: 2000, fetchImpl: ok({ detail: 'Not Found' }) });
      assert.equal(r.status, 'stale-cache');
      assert.ok(r.entries >= 200);
      assert.equal(readFileSync(priceBookCachePath(dir), 'utf8'), before, 'cache untouched');
    });
  });

  it('reports unavailable rather than pricing everything at zero', async () => {
    await withDir(async (dir) => {
      const down = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const r = await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: down });
      assert.equal(r.status, 'unavailable');
      assert.equal(r.book, null);
    });
  });

  it('never touches the network in offline mode', async () => {
    await withDir(async (dir) => {
      await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: ok(many()) });
      let called = false;
      const spy = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      await syncPriceBook({ cacheDir: dir, now: 1000, fetchImpl: spy, offline: true });
      assert.equal(called, false, 'boot must not wait on a third-party host');
    });
  });
});

describe('confidence and source precedence', () => {
  it('orders confidence so disagreements can be settled', () => {
    assert.ok(confidenceRank('VERIFIED') > confidenceRank('LIKELY'));
    assert.ok(confidenceRank('LIKELY') > confidenceRank('STALE'));
    assert.ok(confidenceRank('STALE') > confidenceRank('UNVERIFIED'));
    assert.ok(confidenceRank('UNVERIFIED') > confidenceRank('UNAVAILABLE'));
    assert.equal(strongerConfidence('STALE', 'VERIFIED'), 'VERIFIED');
  });

  it('puts the provider itself above any third party, and the operator above all', () => {
    assert.ok(sourceRank('user-configured') > sourceRank('live-check'));
    assert.ok(sourceRank('live-check') > sourceRank('provider-native'));
    assert.ok(sourceRank('provider-native') > sourceRank('verified-dataset'));
    assert.ok(sourceRank('verified-dataset') > sourceRank('community-catalog'));
    assert.ok(sourceRank('community-catalog') > sourceRank('static-list'));
  });

  it('ages a dated claim down, and treats an undated one as unverified', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    assert.equal(ageAdjusted('LIKELY', '2026-08-19', now), 'LIKELY');
    assert.equal(ageAdjusted('LIKELY', '2025-01-01', now), 'STALE');
    assert.equal(ageAdjusted('VERIFIED', null, now), 'UNVERIFIED', 'no date is no evidence');
  });
});

describe('community registries', () => {
  it('parses the context strings these lists actually use', () => {
    assert.equal(parseTokenCount('128K'), 128000);
    assert.equal(parseTokenCount('1M'), 1000000);
    assert.equal(parseTokenCount('8192'), 8192);
    assert.equal(parseTokenCount('32k'), 32000);
  });

  it('returns null rather than guessing at a context it cannot read', () => {
    // A wrong context window is worse than an absent one: a request sized
    // against it fails at the provider with an error nobody can explain.
    assert.equal(parseTokenCount('unlimited'), null);
    assert.equal(parseTokenCount('varies by model'), null);
    assert.equal(parseTokenCount(''), null);
    assert.equal(parseTokenCount(null), null);
    assert.equal(parseTokenCount('0'), null);
  });

  it('pulls structured limits out of a rate-limit sentence', () => {
    assert.deepEqual(parseRateLimitText('15 RPM, 20K TPD'), {
      requestsPerMinute: 15,
      tokensPerDay: 20000,
    });
    assert.deepEqual(parseRateLimitText('5 RPM / 100 RPD'), {
      requestsPerMinute: 5,
      requestsPerDay: 100,
    });
  });

  it('yields nothing at all from a sentence it cannot parse', () => {
    // Empty, not zeroes. A zero allowance would read as "exhausted".
    assert.deepEqual(parseRateLimitText('generous free tier'), {});
    assert.deepEqual(parseRateLimitText(undefined), {});
  });

  it('turns structured limits into the freeQuota field nothing had populated', () => {
    const p = uzairProviderSchema.parse({
      id: 'x',
      name: 'X',
      freeTier: { type: 'perpetual', limits: { rpm: 20, rpd: 20, tpd: 200000 } },
    });
    assert.deepEqual(freeQuotaOf(p), {
      requestsPerMinute: 20,
      requestsPerDay: 20,
      tokensPerDay: 200000,
    });
  });

  it('reports no quota rather than an empty one when limits are absent', () => {
    const p = uzairProviderSchema.parse({ id: 'x', name: 'X', freeTier: { type: 'perpetual' } });
    assert.equal(freeQuotaOf(p), null);
  });

  it('does not invent terms a community list does not track', () => {
    // This source says nothing about cards, phones or commercial use. Those
    // must stay unknown rather than acquire a cheerful default, or the
    // "no card required" filter becomes a promise Meridian cannot keep.
    const intel = uzairIntelligence(
      uzairProviderSchema.parse({ id: 'x', name: 'X', auth: { envVar: 'X_KEY' }, freeTier: { type: 'perpetual' } }),
      0,
    );
    assert.equal(intel.requirements.card, 'unknown');
    assert.equal(intel.requirements.phone, 'unknown');
    assert.equal(intel.commercialUse, 'unknown');
    assert.equal(intel.requirements.apiKey, 'yes', 'a published env var does mean a key is needed');
    // And a community list is never better than low confidence on its own.
    assert.equal(intel.provenance.confidence, 'low');
  });

  it('drops a model the source could not name', () => {
    const d = mnfstSchema.parse({
      providers: [{ name: 'P', models: [{ id: 'real' }, { id: null }] }],
    });
    assert.deepEqual(namedModels(d.providers[0]!).map((m) => m.id), ['real']);
  });

  it('ranks community catalogues below the verified dataset', () => {
    assert.ok(sourceRank('verified-dataset') > sourceRank('community-catalog'));
    assert.equal(MNFST_METADATA.sourceClass, 'community-catalog');
    assert.equal(UZAIR_METADATA.sourceClass, 'community-catalog');
    // And neither claims to know about pricing.
    assert.equal(MNFST_METADATA.contributes.includes('pricing'), false);
    assert.equal(UZAIR_METADATA.contributes.includes('pricing'), false);
  });
});
