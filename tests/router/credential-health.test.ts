import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetAt, readRateLimitHeaders } from '@meridian/shared';
import { createHarness, credential, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

const chat = { messages: [{ role: 'user' as const, content: 'hello' }] };

/**
 * Accounts, and whose fault a failure is.
 *
 * Meridian's account is a credential — it is what a provider meters, bills and
 * revokes — and until now nothing recorded anything against one. Every failure
 * went to the provider's circuit breaker, which produced the classic
 * multi-tenant fault: one user's revoked key marked the PROVIDER unauthorized,
 * and took it out of rotation for every other user on the instance.
 */

describe('Account health — one caller’s bad key is not everyone’s outage', () => {
  it('does not condemn a provider because one account’s key was rejected', async () => {
    // The provider is healthy and serves anyone with the right token. `u1`'s
    // key is wrong; `u2`'s is correct.
    const p = await startMockProvider('alpha', { requireToken: 'good-key', reply: 'served' });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [
        credential({ id: 'bad', providerId: 'alpha', scope: 'user', userId: 'u1', secret: 'revoked-key' }),
        credential({ id: 'good', providerId: 'alpha', scope: 'user', userId: 'u2', secret: 'good-key' }),
      ],
    });

    await assert.rejects(
      () => h.executor.chat({ modality: 'text', taskType: 'chat', userId: 'u1' }, chat, { retryBudget: 1 }),
      'the caller with the revoked key must be told their call failed',
    );

    // The account carries it.
    const account = h.credentialHealth.get('bad');
    assert.equal(account.state, 'unauthorized');
    assert.equal(account.lastErrorCode, 'authentication_failed');
    assert.ok(account.cooldownUntil != null, 'a rejected key is taken out of rotation');

    // The provider does not. This is the whole point: before, this assertion
    // failed and the provider was marked `unauthorized` with its breaker open.
    const provider = h.health.get('alpha');
    assert.equal(provider.circuit, 'closed', 'one account’s bad key must not open the provider’s breaker');
    assert.notEqual(provider.state, 'unauthorized');

    // And the proof that matters to a person: the other user is unaffected.
    const other = await h.executor.chat({ modality: 'text', taskType: 'chat', userId: 'u2' }, chat);
    assert.equal(other.value.content, 'served');

    // The counterfactual, so this test cannot quietly stop meaning anything.
    // Sending that same 401 to the provider — which is exactly what the code
    // used to do — opens the breaker immediately, because an auth failure is
    // not retryable. That is the outage the split above prevents.
    h.health.recordFailure('alpha', 'authentication_failed', 'as the old code recorded it');
    assert.equal(h.health.get('alpha').circuit, 'open');
    assert.equal(h.health.get('alpha').state, 'unauthorized');
    await p.close();
  });

  it('puts a rate-limited account on cooldown and leaves the provider serving', async () => {
    const p = await startMockProvider('alpha', { rateLimitAfter: 0, retryAfterSec: 30 });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'k', providerId: 'alpha', secret: 's' })],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 1 }));

    const account = h.credentialHealth.get('k');
    assert.equal(account.state, 'rate_limited');
    // The provider's own Retry-After decides how long, because it is the only
    // party that knows when the window rolls.
    assert.equal(account.cooldownUntil, h.now() + 30_000);
    assert.equal(h.health.get('alpha').circuit, 'closed', 'a 429 on one account says nothing about the service');
    await p.close();
  });

  it('keeps a provider fault on the provider and off the account', async () => {
    const p = await startMockProvider('alpha', { alwaysStatus: 503 });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'k', providerId: 'alpha', secret: 's' })],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 4 }));

    // A 503 is the service's problem. Cooling down the key as well would route
    // around capacity that is perfectly good the moment the provider recovers.
    const account = h.credentialHealth.get('k');
    assert.equal(account.cooldownUntil, null, 'a provider outage must not retire a working key');
    assert.notEqual(account.state, 'unauthorized');
    assert.ok(account.lastFailureAt != null, 'though it is still worth recording that a call through it failed');
    assert.ok(h.credentialHealth.available('k'), 'and the account stays usable');
    assert.equal(account.consecutiveFailures, 0, 'and it has no failures of its own to answer for');

    // The provider does. Its breaker opens on its own threshold, which more
    // attempts than this reach; what is asserted here is that the failure was
    // recorded against the provider at all, which is what the account fix
    // could have quietly stopped happening.
    const provider = h.health.get('alpha');
    assert.ok(provider.failureCount > 0, 'the provider is where a 503 is recorded');
    assert.ok(provider.consecutiveFailures > 0);
    assert.equal(provider.state, 'degraded');
    await p.close();
  });

  it('still blames the provider when there is no account to blame', async () => {
    // An anonymous endpoint's rate limit is the endpoint's: with no credential,
    // the provider is the only thing that could be limiting us.
    const p = await startMockProvider('anon', { rateLimitAfter: 0 });
    const h = createHarness({
      providers: [{ ...p.descriptor, auth: 'none' }],
      models: [model({ id: 'anon:m', providerId: 'anon', providerModelId: 'm' })],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 1 }));
    assert.equal(h.health.get('anon').state, 'rate_limited');
    await p.close();
  });
});

describe('Account health — routing uses it', () => {
  it('routes to a second account when the first is cooling down', async () => {
    const p = await startMockProvider('alpha', { reply: 'served' });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [
        credential({ id: 'primary', providerId: 'alpha', secret: 's1', priority: 900 }),
        credential({ id: 'spare', providerId: 'alpha', secret: 's2', priority: 1 }),
      ],
    });

    assert.equal(h.credentials.resolve({ providerId: 'alpha' }, true).credential?.id, 'primary');

    h.credentialHealth.recordFailure('primary', 'alpha', 'rate_limited', 'slow down', 60);
    assert.equal(
      h.credentials.resolve({ providerId: 'alpha' }, true).credential?.id,
      'spare',
      'a key on cooldown must not be handed out, however high its priority',
    );

    h.advance(61_000);
    assert.equal(
      h.credentials.resolve({ providerId: 'alpha' }, true).credential?.id,
      'primary',
      'and it comes back on its own when the cooldown expires',
    );
    await p.close();
  });

  it('says an account is busy rather than claiming none is configured', async () => {
    const p = await startMockProvider('alpha', {});
    const h = createHarness({
      // `auth: 'api-key'` is the point of the test: the credential gate only
      // runs for a provider that needs one.
      providers: [{ ...p.descriptor, auth: 'api-key' }],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'only', providerId: 'alpha', secret: 's' })],
    });

    h.credentialHealth.recordFailure('only', 'alpha', 'rate_limited', 'slow down', 40);
    const preview = h.router.preview({ modality: 'text', taskType: 'chat' });
    const rejection = preview.rejected.find((r) => r.modelId === 'alpha:m');
    assert.ok(rejection, 'the model must be rejected while its only account is cooling down');
    // The old message sent an operator to add a key they already had.
    assert.match(rejection.reason, /rate limited/i);
    assert.doesNotMatch(rejection.reason, /is configured/);
    await p.close();
  });

  it('sorts a health-strategy pool by which key is working, not which is preferred', async () => {
    const p = await startMockProvider('alpha', {});
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [
        credential({ id: 'flaky', providerId: 'alpha', secret: 's1', priority: 900, poolId: 'pool' }),
        credential({ id: 'steady', providerId: 'alpha', secret: 's2', priority: 1, poolId: 'pool' }),
      ],
    });
    h.credentialStore.addPool({ id: 'pool', providerId: 'alpha', name: 'Keys', strategy: 'health', enabled: true, createdAt: 0 });

    // `health` was advertised in the type, accepted by the API and persisted —
    // and behaved identically to `priority`, because nothing per-credential
    // existed to sort on.
    assert.equal(h.credentials.resolve({ providerId: 'alpha' }, true).credential?.id, 'flaky');

    // One failure below the cooldown threshold: still usable, but no longer the
    // one to reach for.
    h.credentialHealth.recordFailure('flaky', 'alpha', 'quota_exhausted', 'out of room');
    h.credentialHealth.reset('flaky');
    h.credentialHealth.recordFailure('flaky', 'alpha', 'rate_limited', 'slow down');
    assert.ok(h.credentialHealth.available('flaky'), 'one soft failure does not take a key out of rotation');
    assert.equal(
      h.credentials.resolve({ providerId: 'alpha' }, true).credential?.id,
      'steady',
      'health must outrank priority when a key has been failing',
    );
    await p.close();
  });
});

describe('Account quota — what the provider actually published', () => {
  it('reads the remaining allowance off a real response', async () => {
    const p = await startMockProvider('alpha', {
      reply: 'served',
      rateLimitHeaders: {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '3',
        'x-ratelimit-reset-requests': '60s',
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-tokens': '199000',
      },
    });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'k', providerId: 'alpha', secret: 's' })],
    });

    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);

    const quotas = h.credentialHealth.quotasFor('k');
    const requests = quotas.find((q) => q.dimension === 'requests');
    assert.ok(requests, 'the request budget must be recorded');
    assert.equal(requests.limit, 1000);
    assert.equal(requests.remaining, 3);
    assert.equal(requests.source, 'provider-headers');
    const tokens = quotas.find((q) => q.dimension === 'tokens');
    assert.equal(tokens?.remaining, 199_000);
    await p.close();
  });

  it('records nothing when a provider publishes nothing', async () => {
    const p = await startMockProvider('alpha', { reply: 'served' });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
      credentials: [credential({ id: 'k', providerId: 'alpha', secret: 's' })],
    });

    await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat);
    // Silence is not "plenty". An invented full allowance is exactly how a
    // free-first policy keeps choosing a route that is already spent.
    assert.deepEqual(h.credentialHealth.quotasFor('k'), []);
    await p.close();
  });

  it('takes an account out of rotation once its published quota is spent', () => {
    const h = createHarness({ providers: [], models: [] });
    h.credentialHealth.recordRateLimit('k', 'alpha', {
      requestsLimit: 100,
      requestsRemaining: 0,
      requestsResetsAt: h.now() + 60_000,
      tokensLimit: null,
      tokensRemaining: null,
      tokensResetsAt: null,
    });
    assert.equal(h.credentialHealth.available('k'), false);
    assert.match(String(h.credentialHealth.unavailableReason('k')), /no requests quota left/);

    // Once the window has rolled the zero is stale, not authoritative.
    h.advance(61_000);
    assert.equal(h.credentialHealth.available('k'), true, 'a spent window that has since reset must not retire the key forever');
  });

  it('never treats an unpublished quota as spent', () => {
    const h = createHarness({ providers: [], models: [] });
    h.credentialHealth.recordRateLimit('k', 'alpha', {
      requestsLimit: 100,
      requestsRemaining: null,
      requestsResetsAt: null,
      tokensLimit: null,
      tokensRemaining: null,
      tokensResetsAt: null,
    });
    assert.equal(h.credentialHealth.available('k'), true);
  });

  it('leaves a dimension alone when a later response says nothing about it', () => {
    const h = createHarness({ providers: [], models: [] });
    const base = {
      requestsLimit: null,
      requestsRemaining: null,
      requestsResetsAt: null,
      tokensLimit: null,
      tokensRemaining: null,
      tokensResetsAt: null,
    };
    h.credentialHealth.recordRateLimit('k', 'alpha', { ...base, tokensLimit: 500, tokensRemaining: 400 });
    h.credentialHealth.recordRateLimit('k', 'alpha', { ...base, requestsLimit: 10, requestsRemaining: 9 });

    const tokens = h.credentialHealth.quotasFor('k').find((q) => q.dimension === 'tokens');
    assert.equal(tokens?.remaining, 400, 'a response silent about tokens is not a response saying tokens are unknown');
  });
});

describe('Rate-limit headers — the shapes providers actually send', () => {
  const now = 1_700_000_000_000;
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  it('reads the x-ratelimit family', () => {
    const s = readRateLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '29000',
      }),
      now,
    );
    assert.equal(s.requestsLimit, 500);
    assert.equal(s.requestsRemaining, 499);
    assert.equal(s.requestsResetsAt, now + 1000);
    assert.equal(s.tokensRemaining, 29_000);
  });

  it('reads Anthropic’s names too', () => {
    const s = readRateLimitHeaders(
      headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-tokens-remaining': '19000',
      }),
      now,
    );
    assert.equal(s.requestsLimit, 50);
    assert.equal(s.tokensRemaining, 19_000);
  });

  it('reports nothing when the response carries nothing', () => {
    const s = readRateLimitHeaders(headers({ 'content-type': 'application/json' }), now);
    assert.deepEqual(Object.values(s), [null, null, null, null, null, null]);
  });

  it('understands the three ways a reset is written', () => {
    assert.equal(parseResetAt('60', now), now + 60_000, 'bare seconds');
    assert.equal(parseResetAt('1m30s', now), now + 90_000, 'a duration');
    assert.equal(parseResetAt('500ms', now), now + 500, 'milliseconds, not half a minute');
    assert.equal(parseResetAt(String(Math.round(now / 1000)), now), now, 'an epoch in seconds');
    assert.equal(parseResetAt(String(now), now), now, 'an epoch in milliseconds');
    assert.equal(parseResetAt('', now), null);
    assert.equal(parseResetAt('nonsense', now), null);
  });
});

describe('Model health — a retired model id is not a provider outage', () => {
  it('keeps a provider serving its other models when one is gone', async () => {
    // The exact shape a stale catalog produces: the provider is up, the key is
    // good, and one model name has been retired. `model_unavailable` is not
    // retryable, so sending it to the provider's breaker opened it
    // immediately — and every other model on that provider became unroutable
    // for five minutes because of one dead id.
    const p = await startMockProvider('alpha', { retiredModels: ['gone'], reply: 'from the live one' });
    const h = createHarness({
      providers: [p.descriptor],
      models: [
        model({ id: 'alpha:gone', providerId: 'alpha', providerModelId: 'gone' }),
        model({ id: 'alpha:live', providerId: 'alpha', providerModelId: 'live' }),
      ],
    });

    // Make the retired one the clear first choice, so this exercises failover
    // rather than a lucky ranking. Pinning it with `model:` would be a
    // different question — a caller who names one model should be told it is
    // gone, not quietly given another.
    h.models.setScores({ modelId: 'alpha:gone', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 3 });

    // The chain moved to the model that works, on the same provider.
    assert.equal(res.modelId, 'live', 'the provider still serves its other models');
    assert.equal(res.value.content, 'from the live one');

    // Asserted on the counters rather than the circuit, and the difference
    // matters: the fallback's own success calls `recordSuccess`, which closes
    // an open circuit again — so a `circuit === 'closed'` assertion here would
    // pass whether or not the 404 was blamed on the provider, and would be a
    // test that proves nothing. `failureCount` and `lastErrorAt` survive a
    // later success.
    const provider = h.health.get('alpha');
    assert.equal(provider.failureCount, 0, 'a retired model id must not be recorded as a provider failure');
    assert.equal(provider.lastErrorAt, null, 'nor leave the provider looking like it errored');
    assert.equal(h.modelHealth.available('alpha:gone'), false, 'the model that is gone is the thing taken out of rotation');
    assert.equal(h.modelHealth.available('alpha:live'), true);
    assert.match(String(h.modelHealth.unavailableReason('alpha:gone')), /no longer serves this model/);
    await p.close();
  });

  it('stops offering the retired model to the router at all', async () => {
    const p = await startMockProvider('alpha', { retiredModels: ['gone'] });
    const h = createHarness({
      providers: [p.descriptor],
      models: [
        model({ id: 'alpha:gone', providerId: 'alpha', providerModelId: 'gone' }),
        model({ id: 'alpha:live', providerId: 'alpha', providerModelId: 'live' }),
      ],
    });
    h.modelHealth.recordFailure('alpha:gone', 'alpha', 'model_unavailable', 'the model does not exist');

    const preview = h.router.preview({ modality: 'text', taskType: 'chat' });
    assert.ok(
      !preview.candidates.some((c) => c.modelId === 'alpha:gone'),
      'a model on cooldown must not be a candidate — otherwise every call spends a request rediscovering the same 404',
    );
    assert.match(String(preview.rejected.find((r) => r.modelId === 'alpha:gone')?.reason), /no longer serves/);
    assert.ok(preview.candidates.some((c) => c.modelId === 'alpha:live'), 'and the working model is still offered');
    await p.close();
  });

  it('does not cool a model down for a fault that is not its own', async () => {
    const p = await startMockProvider('alpha', { alwaysStatus: 503 });
    const h = createHarness({
      providers: [p.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 3 }));
    // A provider outage says nothing about which model ids are valid, and
    // cooling them all would leave nothing to fall back to when it recovers.
    assert.equal(h.modelHealth.available('alpha:m'), true);
    assert.ok(h.health.get('alpha').failureCount > 0, 'the provider is where a 503 belongs');
    await p.close();
  });

  it('treats a context overflow as a fact about the request, not the model', () => {
    const h = createHarness({ providers: [], models: [] });
    h.modelHealth.recordFailure('alpha:m', 'alpha', 'context_length_exceeded', 'too many tokens');
    h.modelHealth.recordFailure('alpha:m', 'alpha', 'context_length_exceeded', 'too many tokens');
    // The same model serves the next, shorter request perfectly. Cooling it
    // down would remove a working model because one caller sent too much.
    assert.equal(h.modelHealth.available('alpha:m'), true);
  });
});
