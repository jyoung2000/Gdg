import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, credential, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';
import type { AIRequest } from '@meridian/shared';

/**
 * A per-credential concurrency limit.
 *
 * `maxConcurrency` on a key exists so an operator can respect a provider's
 * per-account limit with capacity they legitimately own. That makes two things
 * true at once, and they pull in opposite directions: the limit has to bind
 * under concurrent load, and it must not bind against the very call that is
 * holding the slot.
 */

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

const REQUEST: AIRequest = { taskType: 'chat', modality: 'text', messages: MESSAGES };

describe('A per-credential concurrency limit', () => {
  it('still lets a key capped at one serve one call', async () => {
    const provider = await startMockProvider('capped1', { latencyMs: 10, requireToken: 'secret-value' });
    try {
      const h = createHarness({
        providers: [provider.descriptor],
        models: [model({ id: 'capped1:m', providerId: 'capped1', providerModelId: 'm' })],
        credentials: [credential({ id: 'solo', providerId: 'capped1', maxConcurrency: 1 })],
      });

      // One call, nothing else in flight. The slot this call takes is its own,
      // and re-reading the limit after taking it must not read it as full.
      const result = await h.executor.chat(REQUEST, { messages: MESSAGES }, { retryBudget: 1 });
      assert.ok(result.value.content.length > 0, 'a key capped at 1 could not serve a single call');
      assert.equal(h.credentials.concurrencyOf('solo'), 0, 'the slot was not given back');
    } finally {
      await provider.close();
    }
  });

  it('binds under concurrent load rather than admitting everyone', async () => {
    const provider = await startMockProvider('capped2', { latencyMs: 60, requireToken: 'secret-value' });
    try {
      const h = createHarness({
        providers: [provider.descriptor],
        models: [model({ id: 'capped2:m', providerId: 'capped2', providerModelId: 'm' })],
        credentials: [credential({ id: 'one-at-a-time', providerId: 'capped2', maxConcurrency: 2 })],
      });

      const workers = 8;
      const results = await Promise.allSettled(
        Array.from({ length: workers }, () => h.executor.chat(REQUEST, { messages: MESSAGES }, { retryBudget: 1 })),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;

      assert.ok(fulfilled > 0, 'the cap refused every call, so it is not a limit but a block');
      assert.ok(fulfilled <= 2, `${fulfilled} calls ran at once against a key capped at 2`);
      assert.equal(h.credentials.concurrencyOf('one-at-a-time'), 0, 'slots were not given back');

      // And the key that did its job must not be punished for being busy. A
      // refusal Meridian produced never reached the provider, so it is not
      // evidence that the credential is bad — and `unauthorized` is a state
      // nothing clears on its own.
      const health = h.credentialHealth.get('one-at-a-time', 'capped2');
      assert.notEqual(health.state, 'unauthorized', 'a busy key was marked unauthorized');
    } finally {
      await provider.close();
    }
  });

  it('uses a sibling key rather than failing when the routed one starts refusing', async () => {
    // Routing chooses, execution uses, and a retry inside the same request
    // still carries the account routing picked. When that account is the one
    // the provider just rate limited, resolving it again finds it cooling down
    // — and another key the operator configured is capacity they already own.
    const provider = await startMockProvider('rotate', {
      acceptTokens: ['tok-first', 'tok-second'],
      rateLimitTokens: ['tok-first'],
      retryAfterSec: 60,
    });
    try {
      const h = createHarness({
        providers: [provider.descriptor],
        models: [model({ id: 'rotate:m', providerId: 'rotate', providerModelId: 'm' })],
        credentials: [
          credential({ id: 'first', providerId: 'rotate', priority: 200, secret: 'tok-first' }),
          credential({ id: 'second', providerId: 'rotate', priority: 100, secret: 'tok-second' }),
        ],
      });

      const res = await h.executor.chat(REQUEST, { messages: MESSAGES }, { retryBudget: 3 });
      assert.ok(res.value.content.length > 0, 'a healthy sibling key was never tried');
      // And it really was the other account that served it.
      assert.equal(provider.calls.at(-1)?.auth, 'Bearer tok-second');

      assert.equal(h.credentialHealth.get('first', 'rotate').state, 'rate_limited');
      assert.notEqual(h.credentialHealth.get('second', 'rotate').state, 'unauthorized');
    } finally {
      await provider.close();
    }
  });

  it('does not escalate a rate limit into a revoked key', async () => {
    // The retry inside the request re-resolves the account that was just put
    // on a cooldown, finds it unavailable, and used to report that as an
    // authentication failure — which marks the key `unauthorized`, a state
    // that never expires. A 429 became a dead credential.
    const provider = await startMockProvider('escalate', { rateLimitAfter: 0, retryAfterSec: 60, requireToken: 'secret-value' });
    try {
      const h = createHarness({
        providers: [provider.descriptor],
        models: [model({ id: 'escalate:m', providerId: 'escalate', providerModelId: 'm' })],
        credentials: [credential({ id: 'only', providerId: 'escalate' })],
      });

      await assert.rejects(() => h.executor.chat(REQUEST, { messages: MESSAGES }, { retryBudget: 3 }));

      const health = h.credentialHealth.get('only', 'escalate');
      assert.equal(health.state, 'rate_limited', `a 429 left the account in state "${health.state}"`);

      // Nor may Meridian's own refusal to reuse a cooling key count against
      // the provider. The retry never sent a request, so the provider has
      // said nothing — and an opened breaker takes every other model on that
      // provider down with it.
      const breaker = h.health.get('escalate');
      assert.equal(breaker.circuit, 'closed', 'a refusal that never left the process opened the provider breaker');
    } finally {
      await provider.close();
    }
  });
});
