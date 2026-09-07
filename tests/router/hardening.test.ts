import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMeridianError } from '@meridian/shared';
import { FREE, PAID, createHarness, credential, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

describe('Router hardening invariants', () => {
  it('a model with unpublished metered rates never passes free-only routing', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [
        model({
          id: 'alpha:unknown-price',
          providerId: 'alpha',
          providerModelId: 'unknown-price',
          pricing: { kind: 'METERED', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null },
        }),
      ],
      allowPaid: true,
    });

    // FREE must refuse it, and a request without paid permission must refuse it.
    assert.throws(() => h.router.route({ modality: 'text', taskType: 'chat', mode: 'FREE', allowPaid: true }), (e: unknown) => isMeridianError(e));
    assert.throws(() => h.router.route({ modality: 'text', taskType: 'chat', allowPaid: false }), (e: unknown) => isMeridianError(e));
    await a.close();
  });

  it('the instance-wide paid switch overrides a request that asks to pay', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID })],
      allowPaid: false, // the operator said no
    });
    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat', allowPaid: true }),
      (e: unknown) => isMeridianError(e),
      'a request cannot grant itself what the instance forbids',
    );
    await a.close();
  });

  it('a pool strategy never dissolves the FREE guarantee', async () => {
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
    // The frontier pool ranks by quality and would love the paid model; the
    // caller's FREE mode is a hard constraint the pool must not override.
    const decision = h.router.route({ modality: 'text', taskType: 'chat', mode: 'FREE', pool: 'frontier', allowPaid: true });
    assert.equal(decision.model, 'free');
    assert.equal(decision.expectedCost, 0);
    for (const step of decision.fallbackChain) assert.notEqual(step.model, 'paid');
    await a.close();
    await b.close();
  });

  it('an open circuit never becomes primary', async () => {
    const a = await startMockProvider('alpha');
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    for (let i = 0; i < 8; i++) h.health.recordFailure('alpha', 'server_error', 'boom');
    const decision = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.equal(decision.provider, 'beta', 'the provider with an open breaker must not be primary');
    await a.close();
    await b.close();
  });

  it('a disabled provider is never a candidate, whatever it scores', async () => {
    const a = await startMockProvider('alpha');
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.providers.setEnabled('alpha', false);
    const decision = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.equal(decision.provider, 'beta');
    assert.ok(
      decision.routingReason.rejected.some((r) => r.reason.includes('disabled')),
      'the rejection must say the operator disabled it',
    );
    h.providers.setEnabled('alpha', true);
    const back = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.ok(['alpha', 'beta'].includes(back.provider));
    await a.close();
    await b.close();
  });

  it("another user's credential is not capacity this caller can route on", async () => {
    const a = await startMockProvider('alpha', { requireToken: 'user-b-secret' });
    const h = createHarness({
      providers: [{ ...a.descriptor, auth: 'api-key' as const }],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'cred_b', providerId: 'alpha', scope: 'user', userId: 'user-b', secret: 'user-b-secret' })],
    });

    // User B routes fine; user A has no usable credential and must be told so.
    const forB = h.router.route({ modality: 'text', taskType: 'chat', userId: 'user-b' });
    assert.equal(forB.provider, 'alpha');
    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat', userId: 'user-a' }),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates',
    );
    await a.close();
  });

  it('routing previews do not advance credential rotation', async () => {
    const a = await startMockProvider('alpha');
    const marks: string[] = [];
    const h = createHarness({
      providers: [{ ...a.descriptor, auth: 'api-key' as const }],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'cred_1', providerId: 'alpha', secret: 'k1' })],
    });
    h.credentialStore.onMarkUsed = (id) => marks.push(id);

    h.router.route({ modality: 'text', taskType: 'chat' });
    h.router.preview({ modality: 'text', taskType: 'chat' });
    assert.deepEqual(marks, [], 'only execution may mark a credential used');

    const res = h.credentials.resolve({ providerId: 'alpha' }, true);
    assert.ok(res.credential);
    assert.deepEqual(marks, ['cred_1'], 'a committing resolution still marks');
    await a.close();
  });
});
