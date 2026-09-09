import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, credential, model } from '../helpers/harness.js';
import type { AIRequest, Pricing, ProviderDescriptor, RoutingMode } from '@meridian/shared';

/**
 * FREE_FIRST is an ordering, not a weighting.
 *
 * The mode's own description says it "exhausts free capacity before considering
 * anything paid". It was implemented as `free: 0.42` in the weight table, which
 * means a sufficiently good paid model outranks a free one — so the sentence
 * was false, and false in the direction that costs money.
 *
 * A weight expresses a preference. "First" is a guarantee, and this is what
 * makes it one.
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
 * `allowPaid` on the request as well as the instance.
 *
 * Meridian requires both: an operator enabling paid routing and a request
 * asking for it. Without it these tests would pass for the wrong reason — the
 * paid model excluded by the money gate rather than by FREE_FIRST.
 */
function request(mode: RoutingMode): AIRequest {
  return { taskType: 'chat', modality: 'text', mode, allowPaid: true, messages: [{ role: 'user', content: 'hi' }] };
}

/** A mediocre free model and an excellent paid one — the case that exposes a weight. */
function harness() {
  const h = createHarness({
    providers: [provider('freeco'), provider('paidco')],
    models: [
      model({ id: 'freeco:m', providerId: 'freeco', providerModelId: 'm', pricing: FREE }),
      model({ id: 'paidco:m', providerId: 'paidco', providerModelId: 'm', pricing: PAID }),
    ],
    credentials: [credential({ id: 'c-free', providerId: 'freeco' }), credential({ id: 'c-paid', providerId: 'paidco' })],
    allowPaid: true,
  });
  // The paid model is measurably better at everything the scorer looks at.
  h.models.setScores({ modelId: 'paidco:m', coding: 0.99, reasoning: 0.99, general: 0.99, toolUse: 0.99, vision: 0.5, stability: 0.99, samples: 500, updatedAt: 0 });
  h.models.setScores({ modelId: 'freeco:m', coding: 0.2, reasoning: 0.2, general: 0.2, toolUse: 0.2, vision: 0.1, stability: 0.6, samples: 500, updatedAt: 0 });
  return h;
}

describe('FREE_FIRST', () => {
  it('does not consider a paid model while free capacity is available', () => {
    const h = harness();
    const decision = h.router.route(request('FREE_FIRST'));
    assert.equal(decision.provider, 'freeco', 'a better paid model outranked an available free one');
  });

  it('says why the paid options were not used, rather than hiding them', () => {
    // An operator looking at this decision needs to see that paid candidates
    // existed and were passed over deliberately — otherwise the only reading is
    // that Meridian did not know about them.
    const h = harness();
    const decision = h.router.route(request('FREE_FIRST'));
    const why = decision.routingReason.rejected.find((r) => r.modelId === 'paidco:m');
    assert.ok(why, 'the paid candidate vanished from the explanation entirely');
    assert.match(why.reason, /FREE_FIRST/);
  });

  it('leaves the free tier when no free candidate is left', () => {
    // The other half of the guarantee. "Free first" is not "free only": once
    // free capacity is genuinely gone, the request still gets served.
    const h = createHarness({
      providers: [provider('paidco')],
      models: [model({ id: 'paidco:m', providerId: 'paidco', providerModelId: 'm', pricing: PAID })],
      credentials: [credential({ id: 'c-paid', providerId: 'paidco' })],
      allowPaid: true,
    });
    const decision = h.router.route(request('FREE_FIRST'));
    assert.equal(decision.provider, 'paidco');
  });

  it('still refuses paid entirely under FREE', () => {
    // FREE_FIRST prefers; FREE forbids. Conflating them is how someone who
    // asked never to be charged gets charged.
    const h = harness();
    const decision = h.router.route(request('FREE'));
    assert.equal(decision.provider, 'freeco');
    // And with no free model at all, FREE refuses rather than falling back.
    const paidOnly = createHarness({
      providers: [provider('paidco')],
      models: [model({ id: 'paidco:m', providerId: 'paidco', providerModelId: 'm', pricing: PAID })],
      credentials: [credential({ id: 'c-paid', providerId: 'paidco' })],
      allowPaid: true,
    });
    assert.throws(() => paidOnly.router.route(request('FREE')), /No model can serve/);
  });
});
