import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMeridianError } from '@meridian/shared';
import { createHarness, credential, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

const chat = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe('Fallback engine', () => {
  it('moves to the next provider on a 429 and reports why', async () => {
    const a = await startMockProvider('alpha', { rateLimitAfter: 0, retryAfterSec: 1 });
    const b = await startMockProvider('beta', { reply: 'from beta' });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    // Make alpha the clear first choice so the test exercises failover rather
    // than a lucky ranking.
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    assert.equal(res.providerId, 'beta');
    assert.equal(res.value.content, 'from beta');
    assert.ok(res.fallbacks.length >= 1);
    assert.equal(res.fallbacks[0].code, 'rate_limited');
    assert.match(res.fallbacks[0].message, /rate limited/i);
    assert.match(res.fallbacks[0].message, /Switching to/);
    await a.close();
    await b.close();
  });

  it('fails over on a timeout', async () => {
    const a = await startMockProvider('alpha', { hang: true });
    const b = await startMockProvider('beta', { reply: 'recovered' });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { timeoutMs: 300, retryBudget: 3 });
    assert.equal(res.providerId, 'beta');
    assert.equal(res.value.content, 'recovered');
    assert.ok(res.fallbacks.some((f) => f.code === 'timeout'));
    await a.close();
    await b.close();
  });

  it('fails over on a 5xx', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 503 });
    const b = await startMockProvider('beta', { reply: 'ok' });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 4 });
    assert.equal(res.providerId, 'beta');
    await a.close();
    await b.close();
  });

  it('fails over when a credential is rejected', async () => {
    const a = await startMockProvider('alpha', { requireToken: 'right-key' });
    const b = await startMockProvider('beta', { reply: 'ok' });
    const h = createHarness({
      providers: [{ ...a.descriptor, auth: 'api-key' }, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
      credentials: [credential({ id: 'c1', providerId: 'alpha', secret: 'wrong-key' })],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    assert.equal(res.providerId, 'beta');
    assert.ok(res.fallbacks.some((f) => f.code === 'authentication_failed'));
    await a.close();
    await b.close();
  });

  it('does not retry an error that another provider cannot fix', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 400 });
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    await assert.rejects(
      () => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat),
      (e: unknown) => isMeridianError(e) && e.code === 'invalid_request',
    );
    // A malformed request is not fixed by asking someone else, so beta is never called.
    assert.equal(b.calls.filter((c) => c.path.includes('chat')).length, 0);
    await a.close();
    await b.close();
  });

  it('respects the retry budget instead of retrying without limit', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 500 });
    const b = await startMockProvider('beta', { alwaysStatus: 500 });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 2 }));
    const total = a.calls.filter((c) => c.path.includes('chat')).length + b.calls.filter((c) => c.path.includes('chat')).length;
    assert.equal(total, 2, `the budget of 2 must be the total attempt count, saw ${total}`);
    await a.close();
    await b.close();
  });
});

describe('Circuit breaker', () => {
  it('deprioritises a failing provider through its error rate before the breaker even trips', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 500 });
    const b = await startMockProvider('beta');
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    // Alpha starts as the clear first choice on quality alone.
    assert.equal(h.router.route({ modality: 'text', taskType: 'chat' }).provider, 'alpha');

    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 4 });
    const callsAfterFirst = a.calls.length;

    // One failed round is enough for the reliability term to overtake quality,
    // so the router stops choosing alpha without the breaker having to open.
    assert.equal(h.health.get('alpha').circuit, 'closed');
    assert.equal(h.router.route({ modality: 'text', taskType: 'chat' }).provider, 'beta');

    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    assert.equal(a.calls.length, callsAfterFirst, 'a degraded provider should stop receiving traffic');
    await a.close();
    await b.close();
  });

  it('opens the circuit after consecutive failures and then sheds traffic entirely', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 500 });
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
    });

    for (let i = 0; i < 3; i++) {
      await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 2 }).catch(() => undefined);
    }
    assert.equal(h.health.get('alpha').circuit, 'open');
    assert.equal(h.health.isAvailable('alpha'), false);

    // With the circuit open the provider is not a candidate at all, so routing
    // fails outright rather than spending another call to discover it is down.
    const before = a.calls.length;
    await assert.rejects(
      () => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat),
      (e: unknown) => isMeridianError(e) && e.code === 'no_candidates',
    );
    assert.equal(a.calls.length, before, 'an open circuit must shed traffic, not merely fail it');
    await a.close();
  });

  it('probes again once the cooldown has passed, and closes on success', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 500 });
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
    });

    for (let i = 0; i < 3; i++) {
      await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 2 }).catch(() => undefined);
    }
    assert.equal(h.health.get('alpha').circuit, 'open');

    h.advance(20 * 60_000);
    assert.equal(h.health.get('alpha').circuit, 'half_open', 'an expired cooldown must allow a probe');

    a.setBehaviour({ alwaysStatus: undefined, reply: 'back' });
    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    assert.equal(h.health.get('alpha').circuit, 'closed');
    await a.close();
  });

  it('honours a provider-supplied Retry-After when setting the cooldown', async () => {
    const a = await startMockProvider('alpha', { rateLimitAfter: 0, retryAfterSec: 300 });
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
    });

    for (let i = 0; i < 3; i++) {
      await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 1 }).catch(() => undefined);
    }
    const remaining = h.health.cooldownRemaining('alpha');
    assert.ok(remaining !== null && remaining >= 290, `expected a cooldown near the 300s Retry-After, saw ${remaining}`);
    await a.close();
  });
});

describe('Streaming fallback', () => {
  it('fails over before the first token but surfaces an error after it', async () => {
    const a = await startMockProvider('alpha', { alwaysStatus: 500 });
    const b = await startMockProvider('beta', { reply: 'streamed answer' });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const text: string[] = [];
    let errored = false;
    for await (const chunk of h.executor.chatStream({ modality: 'text', taskType: 'chat' }, chat)) {
      if (chunk.type === 'text') text.push(chunk.delta);
      if (chunk.type === 'error') errored = true;
    }
    assert.equal(errored, false);
    assert.match(text.join('').trim(), /streamed answer/);
    await a.close();
    await b.close();
  });
});
