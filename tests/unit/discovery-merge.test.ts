import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscoveryRegistry,
  claimStanding,
  fetchJsonCached,
  isOpenRouterFreeVariant,
  mergeSnapshots,
  openRouterIsFree,
  type DiscoveryContext,
  type DiscoverySource,
  type SourceMetadata,
  type SourceSnapshot,
} from '@meridian/model-sdk';
import type { Pricing, Provenance, ProviderIntelligence } from '@meridian/shared';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.parse('2026-09-09T00:00:00Z');

function metadata(over: Partial<SourceMetadata> & Pick<SourceMetadata, 'id' | 'sourceClass'>): SourceMetadata {
  return {
    displayName: over.id,
    url: `https://example.test/${over.id}`,
    license: 'CC0-1.0',
    attribution: over.id,
    baseConfidence: 'UNVERIFIED',
    contributes: ['providers', 'models', 'pricing', 'limits', 'capabilities', 'access-terms', 'quota'],
    ...over,
  };
}

function provenance(source: string): Provenance {
  return {
    source,
    sourceType: 'dataset',
    sourceUrl: null,
    sourceVersion: null,
    sourceVerified: false,
    verificationMethod: null,
    lastVerified: '2026-09-01',
    confidence: 'low',
    importedAt: NOW,
  };
}

function snapshot(meta: SourceMetadata, over: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    metadata: meta,
    version: null,
    generated: null,
    fetchedAt: NOW,
    fromCache: false,
    cacheAgeDays: 0,
    providers: [],
    models: [],
    error: null,
    ...over,
  };
}

const rate = (input: number): Pricing => ({ kind: 'METERED', inputPerMTok: input, outputPerMTok: input, perRequest: null });

/* ------------------------------------------------------------------ */

describe('Which source wins', () => {
  it('puts proximity to the provider above care taken with second-hand data', () => {
    // The community catalogue is the more confident of the two, and still
    // loses: a provider's own API describing its own models outranks any third
    // party's description of them, however well maintained.
    const community = metadata({ id: 'community', sourceClass: 'community-catalog', baseConfidence: 'LIKELY' });
    const native = metadata({ id: 'native', sourceClass: 'provider-native', baseConfidence: 'UNVERIFIED' });
    assert.ok(claimStanding(native, 'UNVERIFIED') > claimStanding(community, 'LIKELY'));

    const merged = mergeSnapshots([
      snapshot(community, {
        models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(9), provenance: provenance('community'), confidence: 'LIKELY' }],
      }),
      snapshot(native, {
        models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(1), provenance: provenance('native'), confidence: 'UNVERIFIED' }],
      }),
    ]);

    assert.equal(merged.models[0].pricing?.inputPerMTok, 1);
    const origin = merged.models[0].origins.find((o) => o.field === 'pricing');
    assert.equal(origin?.sourceId, 'native');
    assert.deepEqual(origin?.overruled.map((o) => o.sourceId), ['community']);
  });

  it('uses confidence to break ties inside one class', () => {
    const a = metadata({ id: 'a', sourceClass: 'community-catalog' });
    const b = metadata({ id: 'b', sourceClass: 'community-catalog' });
    const merged = mergeSnapshots([
      snapshot(a, { models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(9), provenance: provenance('a'), confidence: 'UNVERIFIED' }] }),
      snapshot(b, { models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(2), provenance: provenance('b'), confidence: 'VERIFIED' }] }),
    ]);
    assert.equal(merged.models[0].pricing?.inputPerMTok, 2);
  });

  it('leaves the incumbent alone on a tie, so a merge is stable across runs', () => {
    // Churn has a cost: a field that flickers between two equally-supported
    // answers makes every diff of the catalogue noise, and makes "what changed
    // upstream" impossible to answer.
    const a = metadata({ id: 'a', sourceClass: 'community-catalog' });
    const b = metadata({ id: 'b', sourceClass: 'community-catalog' });
    const first = snapshot(a, { models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(7), provenance: provenance('a'), confidence: 'LIKELY' }] });
    const second = snapshot(b, { models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', pricing: rate(8), provenance: provenance('b'), confidence: 'LIKELY' }] });
    assert.equal(mergeSnapshots([first, second]).models[0].pricing?.inputPerMTok, 7);
    assert.equal(mergeSnapshots([first, second]).models[0].pricing?.inputPerMTok, 7, 'not stable between calls');
  });
});

describe('What a source is allowed to say', () => {
  it('refuses a claim the source never declared, and reports the refusal', () => {
    // The failure this prevents: a price book adds a `card_required` field
    // upstream, and a catalogue that never checked signup terms starts
    // asserting them. `contributes` is the source's own statement of what it
    // observed, and it is enforced per field rather than trusted.
    const priceOnly = metadata({ id: 'prices', sourceClass: 'verified-dataset', contributes: ['models', 'pricing'] });
    const merged = mergeSnapshots([
      snapshot(priceOnly, {
        models: [
          {
            modelId: 'p:m',
            providerId: 'p',
            providerModelId: 'm',
            pricing: rate(1),
            contextLength: 200_000,
            capabilities: { vision: true },
            provenance: provenance('prices'),
            confidence: 'LIKELY',
          },
        ],
      }),
    ]);
    assert.equal(merged.models[0].pricing?.inputPerMTok, 1, 'the source may set a rate');
    assert.equal(merged.models[0].contextLength, null, 'it may not set a limit it never declared');
    assert.equal(merged.models[0].capabilities, undefined, 'nor a capability');
    assert.deepEqual(
      merged.refusals.map((r) => `${r.sourceId}:${r.field}:${r.count}`).sort(),
      ['prices:capabilities:1', 'prices:limits:1'],
    );
  });

  it('lets a quota-only source publish an allowance without publishing a rate', () => {
    // "15 requests a minute" and "a token costs nothing" are different claims,
    // and a source that makes the first has not made the second.
    const quotaOnly = metadata({ id: 'limits', sourceClass: 'community-catalog', contributes: ['models', 'quota'] });
    const merged = mergeSnapshots([
      snapshot(quotaOnly, {
        models: [
          {
            modelId: 'p:m',
            providerId: 'p',
            providerModelId: 'm',
            pricing: { kind: 'FREE', inputPerMTok: 0, outputPerMTok: 0, perRequest: 0, freeQuota: { requestsPerMinute: 15 } },
            provenance: provenance('limits'),
            confidence: 'UNVERIFIED',
          },
        ],
      }),
    ]);
    assert.deepEqual(merged.models[0].pricing?.freeQuota, { requestsPerMinute: 15 }, 'the allowance came through');
    assert.equal(merged.models[0].pricing?.inputPerMTok, null, 'the zero rate did not');
    assert.equal(merged.models[0].pricing?.kind, 'UNKNOWN', 'and the model is not marked free on its say-so');
  });
});

describe('Unknown never becomes free', () => {
  it('keeps a provider unknown when no source with standing said otherwise', () => {
    // The repository this data comes from is called "awesome free LLM APIs".
    // That is a claim about the list, not about any entry in it, and the
    // difference is a bill.
    const list = metadata({ id: 'a-list-of-free-things', sourceClass: 'community-catalog' });
    const intelligence: ProviderIntelligence = {
      providerId: 'p',
      freeAccess: 'UNKNOWN',
      freeTierSummary: null,
      rateLimitSummary: null,
      caveat: null,
      bestFor: null,
      expires: null,
      requirements: { apiKey: 'unknown', account: 'unknown', card: 'unknown', phone: 'unknown' },
      commercialUse: 'unknown',
      openAiCompatible: 'unknown',
      openAiBaseUrl: null,
      freeModelIds: [],
      modalities: [],
      provenance: provenance('a-list-of-free-things'),
    };
    const merged = mergeSnapshots([
      snapshot(list, { providers: [{ providerId: 'p', descriptor: null, intelligence, unroutableReason: 'no-endpoint' }] }),
    ]);
    assert.equal(merged.providers[0].intelligence?.freeAccess, 'UNKNOWN');
  });

  it('does not let a source without access-terms standing set the free status', () => {
    const noStanding = metadata({ id: 'models-only', sourceClass: 'provider-native', contributes: ['models'] });
    const intelligence = { ...({} as ProviderIntelligence), providerId: 'p', freeAccess: 'FREE_FOREVER' as const, provenance: provenance('models-only') };
    const merged = mergeSnapshots([
      snapshot(noStanding, { providers: [{ providerId: 'p', descriptor: null, intelligence, unroutableReason: null }] }),
    ]);
    assert.equal(merged.providers[0].intelligence, null, 'a source with no standing set the free status');
    assert.equal(merged.refusals[0].field, 'access-terms');
  });
});

describe('A source that fails', () => {
  it('does not take the others down with it', async () => {
    const good: DiscoverySource = {
      metadata: metadata({ id: 'good', sourceClass: 'verified-dataset' }),
      async load() {
        return snapshot(metadata({ id: 'good', sourceClass: 'verified-dataset' }), {
          models: [{ modelId: 'p:m', providerId: 'p', providerModelId: 'm', provenance: provenance('good'), confidence: 'LIKELY' }],
        });
      },
    };
    // `load` is contracted never to throw. This one breaks the contract, which
    // is exactly the case the registry has to survive — a source is a plugin,
    // and a plugin's bug must not be a gateway's failed boot.
    const broken: DiscoverySource = {
      metadata: metadata({ id: 'broken', sourceClass: 'provider-native' }),
      async load() {
        throw new Error('upstream changed its response shape');
      },
    };

    const result = await new DiscoveryRegistry().registerAll([good, broken]).load({ cacheDir: '/nonexistent', now: NOW } as DiscoveryContext);
    assert.equal(result.models.length, 1, 'the working source still produced its models');
    const failed = result.sources.find((s) => s.id === 'broken');
    assert.equal(failed?.ok, false);
    assert.match(failed?.error ?? '', /threw instead of reporting/);
    assert.match(failed?.error ?? '', /upstream changed its response shape/);
  });

  it('refuses to register the same source twice', () => {
    const one: DiscoverySource = { metadata: metadata({ id: 'dup', sourceClass: 'static-list' }), async load() { return snapshot(metadata({ id: 'dup', sourceClass: 'static-list' })); } };
    const registry = new DiscoveryRegistry().register(one);
    assert.throws(() => registry.register(one), /already registered/);
  });
});

/* ------------------------------------------------------------------ */

describe('The cached fetcher', () => {
  const validate = (raw: unknown): raw is { ok: boolean } => !!raw && typeof raw === 'object' && 'ok' in (raw as object);

  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'meridian-http-'));
  }

  it('stores what it fetched, with the validators to revalidate it', async () => {
    const dir = scratch();
    try {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { etag: 'W/"abc"', 'last-modified': 'Mon, 08 Sep 2026 00:00:00 GMT' } })) as typeof fetch;
      const result = await fetchJsonCached({ url: 'https://example.test/d.json', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate });
      assert.equal(result.outcome, 'updated');
      const envelope = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'));
      assert.equal(envelope.etag, 'W/"abc"');
      assert.equal(envelope.lastModified, 'Mon, 08 Sep 2026 00:00:00 GMT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends the validators and treats a 304 as current, not stale', async () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'k.json'), JSON.stringify({ url: 'https://example.test/d.json', etag: 'W/"abc"', lastModified: null, fetchedAt: NOW - 10 * 86_400_000, payload: { ok: true } }));
      let sent: Record<string, string> = {};
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        sent = init.headers as Record<string, string>;
        return new Response(null, { status: 304 });
      }) as unknown as typeof fetch;

      const result = await fetchJsonCached({ url: 'https://example.test/d.json', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate });
      assert.equal(sent['if-none-match'], 'W/"abc"', 'the ETag was not sent, so upstream paid to send the body again');
      assert.equal(result.outcome, 'not-modified');
      // Upstream confirmed the payload, so it is current. Reporting a confirmed
      // document as ten days old would be as misleading as the reverse.
      assert.equal(result.cacheAgeDays, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps serving the last good payload when the fetch fails, and says it is doing so', async () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'k.json'), JSON.stringify({ url: 'https://example.test/d.json', etag: null, lastModified: null, fetchedAt: NOW - 3 * 86_400_000, payload: { ok: true } }));
      const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch;
      const result = await fetchJsonCached({ url: 'https://example.test/d.json', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate });
      assert.equal(result.outcome, 'stale-cache');
      assert.deepEqual(result.payload, { ok: true });
      assert.equal(result.cacheAgeDays, 3, 'the age has to travel with the data or the UI cannot label it');
      assert.match(result.error ?? '', /ENOTFOUND/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not let a 200 carrying the wrong thing overwrite a good cache', async () => {
    // The common upstream failure is not a 500. It is a 200 with an HTML error
    // page, a redirect to a login screen, or a truncated file — all of which
    // parse, and none of which are the document.
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'k.json'), JSON.stringify({ url: 'https://example.test/d.json', etag: null, lastModified: null, fetchedAt: NOW - 86_400_000, payload: { ok: true } }));
      const fetchImpl = (async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 200 })) as typeof fetch;
      const result = await fetchJsonCached({ url: 'https://example.test/d.json', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate, describeInvalid: () => 'it is an error document' });
      assert.equal(result.outcome, 'stale-cache');
      assert.deepEqual(result.payload, { ok: true }, 'the good payload was replaced by the error document');
      assert.match(result.error ?? '', /it is an error document/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')).payload, { ok: true }, 'the cache on disk was overwritten');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a source URL that points into private space', async () => {
    // A dataset URL is configuration, and configuration is user input. Without
    // this, an operator could point the discovery engine at the cloud metadata
    // service and read the response back through the catalogue UI.
    const dir = scratch();
    try {
      let called = false;
      const fetchImpl = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
      const result = await fetchJsonCached({ url: 'http://169.254.169.254/latest/meta-data/', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate });
      assert.equal(called, false, 'the request was made before the address was judged');
      assert.equal(result.outcome, 'unavailable');
      assert.match(result.error ?? '', /Refusing to fetch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads only the cache when told it is offline', async () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'k.json'), JSON.stringify({ url: 'https://example.test/d.json', etag: null, lastModified: null, fetchedAt: NOW, payload: { ok: true } }));
      let called = false;
      const fetchImpl = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
      const result = await fetchJsonCached({ url: 'https://example.test/d.json', cacheDir: dir, cacheKey: 'k', now: NOW, fetchImpl, validate, offline: true });
      assert.equal(called, false);
      assert.deepEqual(result.payload, { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Reading OpenRouter’s rate card', () => {
  it('calls a model free only when every priced dimension is zero', () => {
    assert.equal(openRouterIsFree({ id: 'x', pricing: { prompt: '0', completion: '0', request: '0' } }), true);
    assert.equal(openRouterIsFree({ id: 'x', pricing: { prompt: '0', completion: '0' } }), true, 'an absent per-request charge is not a charge');
    assert.equal(openRouterIsFree({ id: 'x', pricing: { prompt: '0', completion: '0', request: '0.01' } }), false, 'free per token, charged per request');
    assert.equal(openRouterIsFree({ id: 'x', pricing: { prompt: '0.0000005', completion: '0' } }), false);
  });

  it('does not read a missing rate as a zero one', () => {
    // The difference between "we could not read the rate" and "the rate is
    // zero" is the difference between an unexpected bill and no bill.
    assert.equal(openRouterIsFree({ id: 'x' }), false);
    assert.equal(openRouterIsFree({ id: 'x', pricing: {} }), false);
    assert.equal(openRouterIsFree({ id: 'x', pricing: { prompt: 'n/a', completion: 'n/a' } }), false);
  });

  it('knows the provider’s own name for its free variants', () => {
    assert.equal(isOpenRouterFreeVariant('meta-llama/llama-3.3-70b-instruct:free'), true);
    assert.equal(isOpenRouterFreeVariant('meta-llama/llama-3.3-70b-instruct'), false);
    assert.equal(isOpenRouterFreeVariant('freeform/model'), false, 'the word appearing anywhere is not the suffix');
  });
});
