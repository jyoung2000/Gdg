import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, credential, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';
import type { AIRequest, Pricing, ProviderDescriptor } from '@meridian/shared';

/**
 * A daily budget under concurrent load.
 *
 * A budget checked before a call and recorded after it has a window in the
 * middle. Ten requests that each read "spent so far: $0" and then each spend
 * their share is the classic double-spend, and it is invisible to any test that
 * makes one request at a time — which is what every budget test here did.
 *
 * Closing that window takes two things, and the cases below separate them: an
 * admission check that counts what is already in flight, and a hold whose size
 * is a ceiling on the call rather than a guess at it. A hold sized from the
 * router's mid-range estimate closes the window and still overspends, because
 * ten calls each holding a quarter of what they bill is a quarter of a budget.
 */

const PAID_RATE: Pricing = { kind: 'METERED', inputPerMTok: 3, outputPerMTok: 15, perRequest: null };

function descriptorFor(base: ProviderDescriptor): ProviderDescriptor {
  return { ...base, defaultPricing: PAID_RATE };
}

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

const REQUEST = (pool: string): AIRequest => ({
  taskType: 'chat',
  modality: 'text',
  pool,
  allowPaid: true,
  messages: MESSAGES,
});

describe('A pool budget under concurrent load', () => {
  it('does not let concurrent callers spend past the ceiling', async () => {
    const provider = await startMockProvider('paid', { latencyMs: 40, usage: { prompt: 1000, completion: 1000 } });
    try {
      const h = createHarness({
        providers: [descriptorFor(provider.descriptor)],
        models: [model({ id: 'paid:m', providerId: 'paid', providerModelId: 'm', pricing: PAID_RATE })],
        credentials: [credential({ id: 'k', providerId: 'paid' })],
        allowPaid: true,
      });

      // 1,000 in + 1,000 out at $3/$15 per million = $0.018 a call.
      const perCall = (1000 / 1e6) * 3 + (1000 / 1e6) * 15;
      const budget = perCall * 3.5;

      h.pools.upsert({
        id: 'capped',
        name: 'Capped',
        description: 'A pool with a hard daily ceiling',
        strategy: 'BALANCED',
        // The model has to be a member, or the pool is not the thing being
        // tested. The first version of this probe used an empty pool and
        // measured nothing.
        members: [{ modelId: 'paid:m', priority: 1, enabled: true }],
        fallbackPoolId: null,
        maxConcurrency: 16,
        dailyBudget: budget,
        builtin: false,
        enabled: true,
        createdAt: 0,
      });

      const workers = 10;
      const results = await Promise.allSettled(
        Array.from({ length: workers }, () => h.executor.chat(REQUEST('capped'), { messages: MESSAGES }, { retryBudget: 1 })),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const spent = h.pools.usageOf('capped').spentToday;

      // Something must have been refused: ten calls at $0.018 is $0.18 against
      // a ceiling of $0.063.
      assert.ok(fulfilled < workers, `every one of ${workers} concurrent calls was allowed through a ${budget.toFixed(3)} budget`);

      // And the overrun must be bounded by the check-then-act window rather
      // than unbounded. One extra call per worker that was already in flight is
      // the theoretical worst case; anything beyond that is a real leak.
      const ceiling = budget + perCall * workers;
      assert.ok(
        spent <= ceiling,
        `spent $${spent.toFixed(3)} against a $${budget.toFixed(3)} budget — beyond what a check-then-act window can explain`,
      );

      // The accounting has to have happened at all. A budget that "holds"
      // because nothing was ever recorded is not a budget.
      assert.ok(spent > 0, 'nothing was recorded as spent, so the budget was never actually exercised');
    } finally {
      await provider.close();
    }
  });

  it('holds the reservation, not the guess, for the length of each call', async () => {
    // The case above is passed by a budget so tight that a single call's
    // reservation nearly fills it — the very first admission check refuses
    // everyone else, and the in-flight hold is never load-bearing. Give the
    // pool room for several calls at once and the hold is the only thing
    // standing between forty concurrent callers and the ceiling.
    //
    // Measured with the hold sized from the router's mid-range *estimate*
    // instead of its reservation: 40 of 40 admitted, $0.72 billed against a
    // $0.36 budget. With the reservation held: 5 admitted, $0.09 billed.
    const provider = await startMockProvider('paid3', { latencyMs: 40, usage: { prompt: 1000, completion: 1000 } });
    try {
      const h = createHarness({
        providers: [descriptorFor(provider.descriptor)],
        models: [model({ id: 'paid3:m', providerId: 'paid3', providerModelId: 'm', pricing: PAID_RATE })],
        credentials: [credential({ id: 'k3', providerId: 'paid3' })],
        allowPaid: true,
      });

      const perCall = (1000 / 1e6) * 3 + (1000 / 1e6) * 15;
      const budget = perCall * 20;
      h.pools.upsert({
        id: 'roomy',
        name: 'Roomy',
        description: 'Enough budget for several concurrent calls',
        strategy: 'BALANCED',
        members: [{ modelId: 'paid3:m', priority: 1, enabled: true }],
        fallbackPoolId: null,
        // High enough that concurrency is not what is doing the limiting here.
        maxConcurrency: 64,
        dailyBudget: budget,
        builtin: false,
        enabled: true,
        createdAt: 0,
      });

      // What the router predicts and what it reserves are different numbers,
      // deliberately. If they ever converge this test stops testing anything.
      const decision = h.router.route(REQUEST('roomy'));
      assert.ok(
        decision.reservationCost != null && decision.expectedCost != null && decision.reservationCost > decision.expectedCost,
        `a reservation of ${decision.reservationCost} is not above the estimate of ${decision.expectedCost}`,
      );
      assert.ok(
        decision.reservationCost >= perCall,
        `a reservation of ${decision.reservationCost} does not cover a call that bills ${perCall}`,
      );

      const workers = 40;
      const results = await Promise.allSettled(
        Array.from({ length: workers }, () => h.executor.chat(REQUEST('roomy'), { messages: MESSAGES }, { retryBudget: 1 })),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const spent = h.pools.usageOf('roomy').spentToday;

      // Every hold is a ceiling the settled cost fits inside, so admitting a
      // call can never put the pool past its budget: the guarantee here is the
      // budget itself, not "close to" it.
      assert.ok(spent <= budget, `spent $${spent.toFixed(3)} against a $${budget.toFixed(3)} budget`);

      // Neither vacuous end: work got through, and work was refused.
      assert.ok(fulfilled > 0, 'no call succeeded, so the budget was never exercised');
      assert.ok(fulfilled < workers, `all ${workers} concurrent calls were admitted`);
    } finally {
      await provider.close();
    }
  });

  it('refuses every call against a no-spend pool, however many arrive at once', async () => {
    // dailyBudget: 0 is the strictest promise Meridian makes about money. It
    // must not have a concurrency window at all.
    const provider = await startMockProvider('paid2', { latencyMs: 20, usage: { prompt: 500, completion: 500 } });
    try {
      const h = createHarness({
        providers: [descriptorFor(provider.descriptor)],
        models: [model({ id: 'paid2:m', providerId: 'paid2', providerModelId: 'm', pricing: PAID_RATE })],
        credentials: [credential({ id: 'k2', providerId: 'paid2' })],
        allowPaid: true,
      });
      h.pools.upsert({
        id: 'nospend',
        name: 'No spend',
        description: '',
        strategy: 'BALANCED',
        members: [{ modelId: 'paid2:m', priority: 1, enabled: true }],
        fallbackPoolId: null,
        maxConcurrency: 16,
        dailyBudget: 0,
        builtin: false,
        enabled: true,
        createdAt: 0,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => h.executor.chat(REQUEST('nospend'), { messages: MESSAGES }, { retryBudget: 1 })),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 0, `${fulfilled.length} paid calls got through a no-spend pool`);
      assert.equal(h.pools.usageOf('nospend').spentToday, 0);
    } finally {
      await provider.close();
    }
  });
});
