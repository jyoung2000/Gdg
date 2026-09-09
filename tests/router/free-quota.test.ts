import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, credential, model } from '../helpers/harness.js';
import { readRateLimitHeaders, type AIRequest, type Pricing, type ProviderDescriptor, type RoutingMode } from '@meridian/shared';

/**
 * Free routing that knows how much free is left.
 *
 * "Free" as a property of a rate card and "free" as something that will serve
 * this request are different claims. Two free models — one with 900 of 1000
 * daily requests remaining and one with 3 — are not equally good choices, and
 * before this the router could not tell them apart.
 *
 * The failure mode being prevented is specific and common: a free-first policy
 * that keeps choosing the same nearly-exhausted provider, gets a 429, fails
 * over, and repeats — burning a retry budget on a route it already had the
 * evidence to avoid.
 */

const FREE: Pricing = { kind: 'FREE', inputPerMTok: 0, outputPerMTok: 0, perRequest: 0 };
const PAID: Pricing = { kind: 'METERED', inputPerMTok: 3, outputPerMTok: 15, perRequest: null };

function provider(id: string): ProviderDescriptor {
  return {
    id,
    name: id,
    kinds: ['llm'],
    adapter: 'openai-compatible',
    baseUrl: `https://${id}.test/v1`,
    auth: 'api-key',
    envKeys: [],
    trust: 'trusted',
    docsUrl: null,
    local: false,
    supportsDiscovery: true,
    dataUse: { trainingUse: 'not_allowed', commercialUse: 'allowed', retention: null, privacyNote: null, policyUrl: null },
    defaultPricing: FREE,
  };
}

/**
 * Record a quota the way a real response does.
 *
 * Through `readRateLimitHeaders` and `recordRateLimit` rather than by writing a
 * row directly, so what these tests exercise is the path an actual provider
 * response takes: headers on a 200, parsed, stored per credential, read by the
 * router. A test that injected the row would prove the arithmetic and nothing
 * about whether the wiring exists.
 */
function observe(
  h: ReturnType<typeof createHarness>,
  providerId: string,
  headers: Record<string, string>,
): void {
  const snapshot = readRateLimitHeaders(
    { get: (name: string) => headers[name.toLowerCase()] ?? null },
    h.now(),
  );
  h.credentialHealth.recordRateLimit(`cred-${providerId}`, providerId, snapshot);
}

function harnessWith(quotas: { providerId: string; limit: number | null; remaining: number | null; resetsAt?: number | null }[]) {
  const h = createHarness({
    providers: [provider('alpha'), provider('beta')],
    models: [
      model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm', pricing: FREE }),
      model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm', pricing: FREE }),
    ],
    credentials: [
      credential({ id: 'cred-alpha', providerId: 'alpha' }),
      credential({ id: 'cred-beta', providerId: 'beta' }),
    ],
  });
  for (const q of quotas) {
    observe(h, q.providerId, {
      'x-ratelimit-limit-requests': String(q.limit ?? ''),
      'x-ratelimit-remaining-requests': String(q.remaining ?? ''),
      // Seconds until reset, which is how most providers express it.
      'x-ratelimit-reset-requests': q.resetsAt === null ? '' : '3600',
    });
  }
  return h;
}

function request(mode: RoutingMode = 'FREE'): AIRequest {
  return { taskType: 'chat', modality: 'text', mode, messages: [{ role: 'user', content: 'hi' }] };
}

function candidates(h: ReturnType<typeof createHarness>, mode: RoutingMode = 'FREE') {
  return h.router.preview(request(mode)).candidates;
}

function rank(h: ReturnType<typeof createHarness>): { modelId: string; free: number }[] {
  return candidates(h).map((c) => ({ modelId: c.modelId, free: c.factors.free ?? 0 }));
}

describe('Free routing, with the allowance in view', () => {
  it('prefers the free route with room left', () => {
    const h = harnessWith([
      { providerId: 'alpha', limit: 1000, remaining: 3 },
      { providerId: 'beta', limit: 1000, remaining: 900 },
    ]);
    const [first] = rank(h);
    assert.equal(first.modelId, 'beta:m', 'the router chose the nearly-exhausted free route');
  });

  it('treats an unpublished allowance as neutral, not as full and not as empty', () => {
    // Most providers publish nothing. Penalising them would rank models by how
    // talkative their provider's headers are; rewarding them would let silence
    // beat a measured 90% remaining.
    const silent = harnessWith([]);
    const [a, b] = rank(silent);
    assert.equal(a.free, b.free, 'two providers that published nothing were scored differently');

    const measured = harnessWith([{ providerId: 'beta', limit: 1000, remaining: 900 }]);
    const ranked = candidates(measured);
    const alpha = ranked.find((c) => c.modelId === 'alpha:m');
    const beta = ranked.find((c) => c.modelId === 'beta:m');
    // 90% remaining scores 0.2 + 0.8 × 0.9 = 0.92 of the free weight; silence
    // scores the full weight. Silence is not evidence of room, but it is not
    // evidence of the opposite either, so it is not pushed below a route that
    // has actually reported.
    assert.ok((alpha?.factors.free ?? 0) > (beta?.factors.free ?? 0), 'a measured 90% beat an unmeasured provider');
  });

  it('leaves a fully spent route to the credential layer, which removes it and says why', () => {
    // Scoring is for choosing between routes that could work. A route with a
    // published zero cannot, and it is rejected before scoring — by the layer
    // that also knows when the window resets and can put it back.
    //
    // This is asserted rather than assumed because it decides what the headroom
    // signal is *for*: not "avoid the empty one", which is already handled, but
    // "avoid the one about to become empty", which was not.
    const h = harnessWith([{ providerId: 'alpha', limit: 100, remaining: 0 }]);
    const { candidates: scored, rejected } = h.router.preview(request());
    assert.ok(!scored.some((c) => c.modelId === 'alpha:m'), 'a route with no quota left was still offered');
    const why = rejected.find((r) => r.modelId === 'alpha:m');
    assert.match(why?.reason ?? '', /quota left/, `the rejection did not explain itself: ${why?.reason}`);
  });

  it('still puts a nearly-spent free route above a paid one', () => {
    const h = createHarness({
      providers: [provider('alpha'), provider('beta')],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm', pricing: FREE }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm', pricing: PAID }),
      ],
      credentials: [credential({ id: 'cred-alpha', providerId: 'alpha' }), credential({ id: 'cred-beta', providerId: 'beta' })],
      allowPaid: true,
    });
    // Three of a hundred left: nearly gone, and still free. The discount must
    // not be so heavy that it hands the request to a paid model, because paying
    // money to avoid a route that still works is the wrong trade.
    observe(h, 'alpha', {
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '3',
      'x-ratelimit-reset-requests': '3600',
    });
    const scored = candidates(h, 'CHEAP');
    const alpha = scored.find((c) => c.modelId === 'alpha:m');
    const beta = scored.find((c) => c.modelId === 'beta:m');
    assert.ok((alpha?.factors.free ?? 0) > (beta?.factors.free ?? 0), 'a spent free route lost its free advantage over a paid one');
  });

  it('stops applying a reading once its window has reset', () => {
    // After the window rolls over, a zero describes the window before it. A
    // stale zero would keep a recovered account at the back of the queue for as
    // long as nobody called it — which is exactly how it stays uncalled.
    const expired = harnessWith([{ providerId: 'beta', limit: 1000, remaining: 900 }]);
    // A window that resets in one second, observed, and then time passes.
    observe(expired, 'alpha', {
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '1',
    });
    expired.advance(2_000);
    const scored = candidates(expired);
    const alpha = scored.find((c) => c.modelId === 'alpha:m');
    const beta = scored.find((c) => c.modelId === 'beta:m');
    assert.ok((alpha?.factors.free ?? 0) > (beta?.factors.free ?? 0), 'an expired zero was still being applied');
  });
});
