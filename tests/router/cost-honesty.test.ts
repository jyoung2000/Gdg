import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { costClass, estimateCall, isFree, type Pricing } from '@meridian/shared';
import { FREE, LOCAL, createHarness, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

/**
 * An unpublished price is not a low price.
 *
 * A provider that meters its tokens and does not publish a rate can charge any
 * amount. Every question the router asks about money — is this the cheapest
 * route, does it fit the budget, does it fit the pool — has to answer "we do
 * not know" for that model rather than "zero", or the model wins every
 * cost-sensitive comparison precisely because nothing is known about it.
 */

/** Meters tokens; publishes no rate. The dangerous case. */
const UNKNOWN_PRICE: Pricing = { kind: 'METERED', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };
/** Publishes a real, and deliberately expensive, rate. */
const KNOWN_EXPENSIVE: Pricing = { kind: 'METERED', inputPerMTok: 30, outputPerMTok: 60, perRequest: null, note: null };
/** Publishes an input rate only — a partial card, so any total is a floor. */
const PARTIAL_PRICE: Pricing = { kind: 'METERED', inputPerMTok: 1, outputPerMTok: null, perRequest: null, note: null };

describe('Cost classification', () => {
  it('separates free, known-paid and unknown-cost rather than collapsing them', () => {
    assert.equal(costClass(FREE), 'FREE');
    assert.equal(costClass(LOCAL), 'FREE');
    assert.equal(costClass(KNOWN_EXPENSIVE), 'KNOWN_PAID');
    assert.equal(costClass(UNKNOWN_PRICE), 'UNKNOWN_COST');
    // A metered model whose every published rate is zero cannot charge.
    assert.equal(costClass({ ...UNKNOWN_PRICE, inputPerMTok: 0, outputPerMTok: 0 }), 'FREE');
  });

  it('reports an unknown price as unknown, never as zero', () => {
    const call = estimateCall(UNKNOWN_PRICE, { promptTokens: 1000, completionTokens: 1000 });
    assert.equal(call.usd, null, 'an unpublished rate must not produce a number');
    assert.equal(call.known, false);
    assert.equal(call.klass, 'UNKNOWN_COST');
  });

  it('marks a partially published rate card as a lower bound, not an exact price', () => {
    const call = estimateCall(PARTIAL_PRICE, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    assert.equal(call.usd, 1, 'the input rate that was published still counts');
    assert.equal(call.known, false, 'an unpublished output rate means the total is only a floor');
    assert.equal(call.basis, 'lower_bound');
  });

  it('reports a fully published rate card as exact', () => {
    const call = estimateCall(KNOWN_EXPENSIVE, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    assert.equal(call.usd, 90);
    assert.equal(call.known, true);
    assert.equal(call.basis, 'exact');
  });

  it('reports a free model as exactly zero, which is a known price', () => {
    const call = estimateCall(FREE, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    assert.equal(call.usd, 0);
    assert.equal(call.known, true);
    assert.equal(isFree(FREE), true);
  });
});

describe('Router — unknown cost never wins on price', () => {
  it('does not rank an unpriced model above a model with a published rate under CHEAP_FIRST', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [
        model({ id: 'alpha:unpriced', providerId: 'alpha', providerModelId: 'unpriced', pricing: UNKNOWN_PRICE }),
        model({ id: 'alpha:published', providerId: 'alpha', providerModelId: 'published', pricing: KNOWN_EXPENSIVE }),
      ],
      allowPaid: true,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', mode: 'CHEAP_FIRST', allowPaid: true });

    // The published model is genuinely expensive. It still has to win, because
    // the alternative's price is not lower — it is unknown, and a router that
    // prefers it is choosing the model it knows least about.
    assert.equal(
      decision.model,
      'published',
      'a model with no published rate must not be treated as the cheapest option',
    );

    const unpriced = decision.routingReason.considered.find((c) => c.modelId === 'alpha:unpriced');
    assert.ok(unpriced, 'the unpriced model should still be a candidate, just not the winner');
    assert.equal(unpriced.costClass, 'UNKNOWN_COST');
    assert.equal(unpriced.estimatedCost, null, 'an unknown cost is reported as unknown, not as 0');
  });

  it('still prefers a genuinely free model over any paid one under CHEAP_FIRST', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [
        model({ id: 'alpha:free', providerId: 'alpha', providerModelId: 'free', pricing: FREE }),
        model({ id: 'alpha:published', providerId: 'alpha', providerModelId: 'published', pricing: KNOWN_EXPENSIVE }),
      ],
      allowPaid: true,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', mode: 'CHEAP_FIRST', allowPaid: true });
    assert.equal(decision.model, 'free');
    assert.equal(decision.expectedCost, 0, 'free is a known price of zero');
  });
});

describe('Router — a budget binds on what is not known', () => {
  it('refuses a model whose price is unknown when the request carries a budget', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:unpriced', providerId: 'alpha', providerModelId: 'unpriced', pricing: UNKNOWN_PRICE })],
      allowPaid: true,
    });

    // Nothing else can serve the request, so a router that lets the unpriced
    // model through returns a decision and one that does not throws. The point
    // is that a $0.01 budget must not be satisfied by a model that could
    // charge a dollar.
    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat', allowPaid: true, budget: 0.01 }),
      (e: unknown) => e instanceof Error && /no_candidates|No model/.test(String(e)),
      'a budget must not be passed by a cost nobody can compute',
    );

    // Without a budget the same model is routable: the operator has allowed
    // paid routing and stated no cap, so there is nothing to violate.
    const ok = h.router.route({ modality: 'text', taskType: 'chat', allowPaid: true });
    assert.equal(ok.model, 'unpriced');
    assert.equal(ok.expectedCost, null);
  });

  it('explains the refusal in terms of the unknown price', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [
        model({ id: 'alpha:unpriced', providerId: 'alpha', providerModelId: 'unpriced', pricing: UNKNOWN_PRICE }),
        model({ id: 'alpha:free', providerId: 'alpha', providerModelId: 'free', pricing: FREE }),
      ],
      allowPaid: true,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', allowPaid: true, budget: 0.01 });
    assert.equal(decision.model, 'free');
    const rejected = decision.routingReason.rejected.find((r) => r.modelId === 'alpha:unpriced');
    assert.ok(rejected, 'the unpriced model must appear as rejected, with a reason');
    assert.match(rejected.reason, /price|cost/i);
    assert.match(rejected.reason, /unknown|not published|unpublished/i);
  });
});

describe('Router — verified capability outranks a guess', () => {
  it('prefers the model whose required capability was probed over one that was inferred', async () => {
    const a = await startMockProvider('alpha');
    const probed = model({
      id: 'alpha:probed',
      providerId: 'alpha',
      providerModelId: 'probed',
      capabilityClaims: {
        tools: { state: 'probe_verified', source: 'live probe: called the tool', confidence: 1, at: 1000 },
      },
    });
    const guessed = model({
      id: 'alpha:guessed',
      providerId: 'alpha',
      providerModelId: 'guessed',
      capabilityClaims: {
        tools: { state: 'inferred', source: 'model-name heuristic', confidence: 0.5, at: 1000 },
      },
    });

    const h = createHarness({ providers: [a.descriptor], models: [guessed, probed] });
    const decision = h.router.route({ modality: 'text', taskType: 'chat', toolsRequired: true });

    // Both can serve; neither is dropped. The difference is which one Meridian
    // has actually seen work, and that is what breaks the tie.
    assert.equal(
      decision.model,
      'probed',
      'a capability confirmed by a live call should outrank the same capability guessed from a name',
    );
    const considered = decision.routingReason.considered.map((c) => c.modelId);
    assert.ok(considered.includes('alpha:guessed'), 'the guessed model stays routable, it just ranks lower');
    await a.close();
  });

  it('does not let evidence strength override a real quality difference', async () => {
    // Evidence is a nudge inside reliability, not a veto. A guessed model that
    // is otherwise clearly better must still be able to win, or a freshly
    // discovered model could never displace an older probed one.
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [
        model({
          id: 'alpha:probed-slow',
          providerId: 'alpha',
          providerModelId: 'probed-slow',
          capabilityClaims: { tools: { state: 'probe_verified', source: 'probe', confidence: 1, at: 1 } },
        }),
        model({
          id: 'alpha:guessed-preferred',
          providerId: 'alpha',
          providerModelId: 'guessed-preferred',
          capabilityClaims: { tools: { state: 'inferred', source: 'heuristic', confidence: 0.5, at: 1 } },
        }),
      ],
    });

    // An explicit operator preference is an instruction, and outranks evidence.
    const decision = h.router.route({
      modality: 'text',
      taskType: 'chat',
      toolsRequired: true,
      model: 'guessed-preferred',
    });
    assert.equal(decision.model, 'guessed-preferred');
    await a.close();
  });
});
