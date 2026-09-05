import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMeridianError, type InferencePool, type Reservation } from '@meridian/shared';
import { PoolManager } from '@meridian/routing-sdk';
import { FREE, PAID, createHarness, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

function pool(overrides: Partial<InferencePool> & Pick<InferencePool, 'id' | 'name'>): InferencePool {
  return {
    description: null,
    strategy: 'BALANCED',
    members: [],
    fallbackPoolId: null,
    maxConcurrency: null,
    dailyBudget: null,
    builtin: false,
    enabled: true,
    createdAt: 0,
    ...overrides,
  };
}

describe('Inference pools', () => {
  it('restricts routing to a pool’s members', async () => {
    const a = await startMockProvider('alpha');
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.pools.upsert(pool({ id: 'only-beta', name: 'Only Beta', members: [{ modelId: 'beta:m', priority: 100, enabled: true }] }));

    const decision = h.router.route({ modality: 'text', taskType: 'chat', pool: 'only-beta' });
    assert.equal(decision.provider, 'beta');
    assert.equal(decision.pool, 'only-beta');
    await a.close();
    await b.close();
  });

  it('applies the pool’s own strategy in place of the caller’s mode', async () => {
    const a = await startMockProvider('alpha');
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID }),
        model({ id: 'beta:free', providerId: 'beta', providerModelId: 'free', pricing: FREE }),
      ],
      allowPaid: true,
    });
    h.models.setScores({ modelId: 'alpha:paid', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });
    h.pools.upsert(pool({ id: 'strictly-free', name: 'Strictly free', strategy: 'FREE' }));

    // BEST would normally pick the high-scoring paid model; the pool's FREE
    // policy overrides it, because choosing a pool is choosing a policy.
    const decision = h.router.route({ modality: 'text', taskType: 'chat', pool: 'strictly-free', mode: 'BEST', allowPaid: true });
    assert.equal(decision.model, 'free');
    await a.close();
    await b.close();
  });

  it('refuses a call that would breach a no-spend pool', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID })],
      allowPaid: true,
    });
    h.pools.upsert(pool({ id: 'nospend', name: 'No spend', dailyBudget: 0 }));

    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat', pool: 'nospend', allowPaid: true, prompt: 'x'.repeat(4000) }),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates',
    );
    await a.close();
  });

  it('blocks a pool that is at its concurrency ceiling', () => {
    const pools = new PoolManager(() => 1000);
    pools.upsert(pool({ id: 'p', name: 'P', maxConcurrency: 2 }));

    const r1 = pools.acquire('p');
    const r2 = pools.acquire('p');
    assert.match(pools.capacityBlock('p', 0) ?? '', /concurrency limit/);
    r1();
    assert.equal(pools.capacityBlock('p', 0), null);
    r2();
  });

  it('tracks daily spend and stops at the budget', () => {
    const pools = new PoolManager(() => 1_700_000_000_000);
    pools.upsert(pool({ id: 'p', name: 'P', dailyBudget: 1 }));

    pools.recordSpend('p', 0.75);
    assert.equal(pools.capacityBlock('p', 0.1), null);
    assert.match(pools.capacityBlock('p', 0.5) ?? '', /daily budget/);
  });

  it('follows the fallback chain without looping', () => {
    const pools = new PoolManager(() => 0);
    pools.upsert(pool({ id: 'a', name: 'A', fallbackPoolId: 'b' }));
    pools.upsert(pool({ id: 'b', name: 'B', fallbackPoolId: 'c' }));
    // A cycle back to 'a' must terminate rather than spin.
    pools.upsert(pool({ id: 'c', name: 'C', fallbackPoolId: 'a' }));

    assert.deepEqual(pools.fallbackChain('a'), ['b', 'c']);
  });
});

describe('Reservations', () => {
  function reservation(overrides: Partial<Reservation> & Pick<Reservation, 'id' | 'poolId'>): Reservation {
    return {
      label: 'test',
      startAt: 1000,
      endAt: 5000,
      maxConcurrency: 8,
      budget: null,
      fallbackPoolId: null,
      models: [],
      status: 'scheduled',
      used: 0,
      spend: 0,
      createdAt: 0,
      ...overrides,
    };
  }

  it('raises the concurrency ceiling only inside its window', () => {
    let clock = 500;
    const pools = new PoolManager(() => clock);
    pools.upsert(pool({ id: 'p', name: 'P', maxConcurrency: 2 }));
    pools.addReservation(reservation({ id: 'r', poolId: 'p', maxConcurrency: 16 }));

    assert.equal(pools.concurrencyLimit('p'), 2, 'before the window the pool limit applies');
    clock = 2000;
    assert.equal(pools.concurrencyLimit('p'), 16, 'inside the window the reservation applies');
    clock = 9000;
    assert.equal(pools.concurrencyLimit('p'), 2, 'after the window the pool limit applies again');
  });

  it('restricts routing to the reservation’s models while active', () => {
    let clock = 2000;
    const pools = new PoolManager(() => clock);
    pools.upsert(pool({ id: 'p', name: 'P', members: [{ modelId: 'a:1', priority: 1, enabled: true }, { modelId: 'b:1', priority: 1, enabled: true }] }));
    pools.addReservation(reservation({ id: 'r', poolId: 'p', models: ['b:1'] }));

    assert.deepEqual(pools.eligibleModels('p').modelIds, ['b:1']);
    clock = 9000;
    assert.deepEqual(pools.eligibleModels('p').modelIds.sort(), ['a:1', 'b:1']);
  });

  it('reports its status from the clock, not from a stale stored value', () => {
    let clock = 500;
    const pools = new PoolManager(() => clock);
    pools.upsert(pool({ id: 'p', name: 'P' }));
    pools.addReservation(reservation({ id: 'r', poolId: 'p', status: 'scheduled' }));

    assert.equal(pools.listReservations()[0].status, 'scheduled');
    clock = 2000;
    assert.equal(pools.listReservations()[0].status, 'active');
    clock = 9000;
    assert.equal(pools.listReservations()[0].status, 'expired');
  });

  it('accrues spend against the active reservation', () => {
    const pools = new PoolManager(() => 2000);
    pools.upsert(pool({ id: 'p', name: 'P' }));
    pools.addReservation(reservation({ id: 'r', poolId: 'p', budget: 5 }));

    pools.recordSpend('p', 1.25);
    const r = pools.listReservations()[0];
    assert.equal(r.spend, 1.25);
    assert.equal(r.used, 1);
  });

  it('an empty pool is unconstrained rather than a dead end', () => {
    const pools = new PoolManager(() => 0);
    pools.upsert(pool({ id: 'p', name: 'P', members: [] }));
    const { modelIds, unconstrained } = pools.eligibleModels('p');
    assert.equal(unconstrained, true);
    assert.equal(modelIds.length, 0);
  });
});
