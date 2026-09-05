import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMeridianError } from '@meridian/shared';
import { FREE, LOCAL, PAID, createHarness, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

async function twoProviders() {
  const a = await startMockProvider('alpha');
  const b = await startMockProvider('beta');
  return { a, b };
}

describe('Router — hard constraints', () => {
  it('never selects a model whose provider has no adapter', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, { ...b.descriptor, adapter: 'not-registered' }],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.equal(decision.provider, 'alpha');
    assert.ok(decision.routingReason.rejected.some((r) => r.reason.includes('No adapter')));
    await a.close();
    await b.close();
  });

  it('never selects a model that cannot serve the modality', async () => {
    const { a } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:text', providerId: 'alpha', providerModelId: 'text', modalities: ['text'] })],
    });

    assert.throws(
      () => h.router.route({ modality: 'image', taskType: 'image-generation' }),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates',
    );
    await a.close();
  });

  it('refuses to spend money unless paid routing is explicitly permitted', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:cheap', providerId: 'alpha', providerModelId: 'cheap', pricing: PAID }),
        model({ id: 'beta:free', providerId: 'beta', providerModelId: 'free', pricing: FREE }),
      ],
      allowPaid: false,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.equal(decision.provider, 'beta', 'a paid model must not be selected when paid routing is off');
    assert.equal(decision.expectedCost, 0);
    await a.close();
    await b.close();
  });

  it('allows a paid model only when the instance and the request both permit it', async () => {
    const { a } = await twoProviders();
    const paidOnly = [model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID })];

    const blocked = createHarness({ providers: [a.descriptor], models: paidOnly, allowPaid: true });
    assert.throws(() => blocked.router.route({ modality: 'text', taskType: 'chat' }), (e: unknown) => isMeridianError(e));

    const permitted = createHarness({ providers: [a.descriptor], models: paidOnly, allowPaid: true });
    const decision = permitted.router.route({ modality: 'text', taskType: 'chat', allowPaid: true });
    assert.equal(decision.model, 'paid');
    assert.ok(decision.expectedCost > 0);
    await a.close();
  });

  it('honours a request budget', async () => {
    const { a } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID })],
      allowPaid: true,
    });

    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat', allowPaid: true, budget: 0.0000001 }),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates',
    );
    await a.close();
  });

  it('excludes non-local providers under STRICT_LOCAL', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, { ...b.descriptor, local: true }],
      models: [
        model({ id: 'alpha:remote', providerId: 'alpha', providerModelId: 'remote' }),
        model({ id: 'beta:local', providerId: 'beta', providerModelId: 'local', pricing: LOCAL }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', privacyMode: 'STRICT_LOCAL' });
    assert.equal(decision.provider, 'beta');
    await a.close();
    await b.close();
  });

  it('keeps a sensitive request away from providers that are not verified or trusted', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [{ ...a.descriptor, trust: 'unknown' }, { ...b.descriptor, trust: 'verified' }],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', sensitive: true, privacyMode: 'ANY_PROVIDER' });
    assert.equal(decision.provider, 'beta');
    assert.ok(decision.routingReason.rejected.some((r) => r.reason.includes('sensitive')));
    await a.close();
    await b.close();
  });

  it('rejects a model whose context window is too small', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:small', providerId: 'alpha', providerModelId: 'small', contextLength: 8192 }),
        model({ id: 'beta:big', providerId: 'beta', providerModelId: 'big', contextLength: 200_000 }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', contextLength: 100_000 });
    assert.equal(decision.model, 'big');
    await a.close();
    await b.close();
  });

  it('requires tool support when the request needs tools', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:notools', providerId: 'alpha', providerModelId: 'notools', capabilities: ['text'] }),
        model({ id: 'beta:tools', providerId: 'beta', providerModelId: 'tools', capabilities: ['text', 'tools'] }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'coding', toolsRequired: true });
    assert.equal(decision.model, 'tools');
    await a.close();
    await b.close();
  });
});

describe('Router — modes', () => {
  it('FREE mode selects only models that cannot charge', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:paid', providerId: 'alpha', providerModelId: 'paid', pricing: PAID }),
        model({ id: 'beta:free', providerId: 'beta', providerModelId: 'free', pricing: FREE }),
      ],
      allowPaid: true,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', mode: 'FREE', allowPaid: true });
    assert.equal(decision.model, 'free');
    await a.close();
    await b.close();
  });

  it('LOCAL mode selects only local providers', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, { ...b.descriptor, local: true }],
      models: [
        model({ id: 'alpha:remote', providerId: 'alpha', providerModelId: 'remote' }),
        model({ id: 'beta:local', providerId: 'beta', providerModelId: 'local', pricing: LOCAL }),
      ],
    });

    assert.equal(h.router.route({ modality: 'text', taskType: 'chat', mode: 'LOCAL' }).provider, 'beta');
    await a.close();
    await b.close();
  });

  it('FAST prefers the lower measured latency; BEST prefers the higher score', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:quick', providerId: 'alpha', providerModelId: 'quick' }),
        model({ id: 'beta:smart', providerId: 'beta', providerModelId: 'smart' }),
      ],
    });

    h.models.setPerformance({ modelId: 'alpha:quick', ttftMs: 100, latencyMs: 400, p95LatencyMs: 500, jitterMs: 20, tokensPerSecond: 200, uptime: 1, samples: 50, updatedAt: 0 });
    h.models.setPerformance({ modelId: 'beta:smart', ttftMs: 900, latencyMs: 9000, p95LatencyMs: 12000, jitterMs: 900, tokensPerSecond: 20, uptime: 1, samples: 50, updatedAt: 0 });
    h.models.setScores({ modelId: 'alpha:quick', coding: 40, reasoning: 40, general: 40, toolUse: 60, vision: null, stability: 0.9, samples: 60, updatedAt: 0 });
    h.models.setScores({ modelId: 'beta:smart', coding: 96, reasoning: 96, general: 96, toolUse: 95, vision: null, stability: 0.98, samples: 60, updatedAt: 0 });

    assert.equal(h.router.route({ modality: 'text', taskType: 'chat', mode: 'FAST' }).model, 'quick');
    assert.equal(h.router.route({ modality: 'text', taskType: 'chat', mode: 'BEST' }).model, 'smart');
    await a.close();
    await b.close();
  });

  it('CHEAP prefers the cheaper of two paid models', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:dear', providerId: 'alpha', providerModelId: 'dear', pricing: { kind: 'METERED', inputPerMTok: 30, outputPerMTok: 90, perRequest: null } }),
        model({ id: 'beta:cheap', providerId: 'beta', providerModelId: 'cheap', pricing: { kind: 'METERED', inputPerMTok: 0.1, outputPerMTok: 0.3, perRequest: null } }),
      ],
      allowPaid: true,
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat', mode: 'CHEAP', allowPaid: true, prompt: 'hello world' });
    assert.equal(decision.model, 'cheap');
    await a.close();
    await b.close();
  });
});

describe('Router — explanation', () => {
  it('explains the choice and names what it ruled out', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:novision', providerId: 'beta', providerModelId: 'novision', modalities: ['text'] }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'coding' });
    assert.ok(decision.routingReason.summary.length > 20, 'summary should be a real sentence');
    assert.ok(decision.routingReason.criteria.length >= 4);
    assert.ok(decision.routingReason.criteria.every((c) => typeof c.met === 'boolean'));
    assert.equal(decision.routingReason.mode, 'AUTO');
    await a.close();
    await b.close();
  });

  it('builds a fallback chain that prefers a different provider first', async () => {
    const { a, b } = await twoProviders();
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:one', providerId: 'alpha', providerModelId: 'one' }),
        model({ id: 'alpha:two', providerId: 'alpha', providerModelId: 'two' }),
        model({ id: 'beta:one', providerId: 'beta', providerModelId: 'one' }),
      ],
    });

    const decision = h.router.route({ modality: 'text', taskType: 'chat' });
    assert.ok(decision.fallbackChain.length >= 1);
    assert.notEqual(decision.fallbackChain[0].provider, decision.provider, 'the first fallback must be on a different provider');
    await a.close();
    await b.close();
  });

  it('reports why nothing matched rather than failing silently', async () => {
    const h = createHarness({ providers: [], models: [] });
    assert.throws(
      () => h.router.route({ modality: 'text', taskType: 'chat' }),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates' && e.message.includes('connect a provider'),
    );
  });
});
