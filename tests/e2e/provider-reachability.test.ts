import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMeridianError, nullLogger } from '@meridian/shared';
import { createRegistry, type AdapterContext, type ProviderAdapter } from '@meridian/provider-sdk';
import { CredentialHealthStore, HealthStore } from '@meridian/routing-sdk';

/**
 * Provider adapters against the providers themselves, with no credential.
 *
 * Every hosted adapter in this repository has been exercised only against a
 * local simulator, because the network policy here reaches almost nothing. Two
 * provider APIs are reachable — `api.anthropic.com` and
 * `generativelanguage.googleapis.com` — and while neither can be asked to
 * generate anything without a key, an unauthenticated request still proves
 * things a simulator never can:
 *
 * - the adapter's URL, method and headers reach the real service rather than a
 *   404 or a redirect,
 * - the request is well-formed enough for the service to get as far as checking
 *   the credential,
 * - and the error that comes back is classified the way the fallback engine and
 *   the account ledger need it to be.
 *
 * That last one is not hypothetical. This file is how the Google
 * classification defect was found: a bad key there answers **400
 * API_KEY_INVALID**, not 401, and Meridian read it as a malformed request —
 * which does not fail over and is not an account fault, so the chain stopped
 * dead and the dead key stayed in rotation.
 *
 * Deliberately one request per provider per run, with an obviously invalid key.
 * Nothing here attempts to use, guess or work around a credential, and a
 * provider that cannot be reached is reported as unreached rather than assumed
 * fine.
 */

const REACH_TIMEOUT_MS = 8_000;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REACH_TIMEOUT_MS), method: 'GET' });
    // Any HTTP answer means the service is reachable. A 401 or a 400 is exactly
    // what an unauthenticated request should get, and is the point.
    return res.status > 0;
  } catch {
    return false;
  }
}

function ctx(secret: string): AdapterContext {
  return {
    secret,
    logger: nullLogger,
    requestId: 'reachability',
    timeoutMs: 15_000,
  };
}

/** An unmistakably fake key. Never a real one, never a guess at one. */
const NOT_A_KEY = 'meridian-reachability-probe-not-a-real-key';

describe('Provider adapters against the real APIs, unauthenticated', () => {
  const registry = createRegistry();
  let anthropicUp = false;
  let googleUp = false;

  before(async () => {
    [anthropicUp, googleUp] = await Promise.all([
      reachable('https://api.anthropic.com/v1/models'),
      reachable('https://generativelanguage.googleapis.com/v1beta/models'),
    ]);
  });

  const adapterFor = (id: string): ProviderAdapter => {
    const adapter = registry.get(id);
    assert.ok(adapter, `the ${id} adapter must be registered`);
    return adapter;
  };

  it('reaches Anthropic and is told, in Meridian’s own vocabulary, that the key is bad', async (t) => {
    if (!anthropicUp) return t.skip('api.anthropic.com is not reachable from here');
    const adapter = adapterFor('anthropic');

    const err = await adapter
      .chat!({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 }, ctx(NOT_A_KEY))
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(isMeridianError(err), `expected a typed Meridian error, got ${String(err)}`);
    assert.equal(err.code, 'authentication_failed', 'a 401 from the real API must classify as an auth failure');
    assert.equal(err.providerId, 'anthropic');

    // The request got far enough to be authenticated, which means the URL, the
    // method, the `anthropic-version` header and the body shape were all
    // acceptable to the real service. A malformed body answers differently.
    assert.match(err.message.toLowerCase(), /(api[_ -]?key|authentication|credential)/);

    // And the key never comes back out. A provider that echoed it into an error
    // must not turn Meridian's error into a second place it leaks from.
    assert.ok(!JSON.stringify(err.details ?? {}).includes(NOT_A_KEY), 'the key must not survive into the error details');
    assert.ok(!err.message.includes(NOT_A_KEY), 'nor into the message');
  });

  it('reaches Google, whose bad-key answer is a 400 rather than a 401', async (t) => {
    if (!googleUp) return t.skip('generativelanguage.googleapis.com is not reachable from here');
    const adapter = adapterFor('google');

    const err = await adapter
      .listModels!(ctx(NOT_A_KEY))
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(isMeridianError(err), `expected a typed Meridian error, got ${String(err)}`);
    // The whole point of this test. Google answers 400 with API_KEY_INVALID,
    // and reading that as `invalid_request` cost three separate behaviours:
    // the caller was misinformed, the fallback chain stopped because
    // `invalid_request` does not fail over, and the account was never marked
    // unauthorized so the dead key stayed in rotation.
    assert.equal(err.code, 'authentication_failed', 'a 400 that says the key is invalid is an auth failure');
    assert.ok(!JSON.stringify(err.details ?? {}).includes(NOT_A_KEY), 'the key must not survive into the error details');
  });

  it('lands a real provider’s auth failure on the account and not on the provider', async (t) => {
    if (!googleUp) return t.skip('generativelanguage.googleapis.com is not reachable from here');
    // The multi-tenant fix, exercised against a real provider rather than a
    // mock: one caller's bad key must not take Google out of rotation for
    // everyone else on the instance.
    const adapter = adapterFor('google');
    const providerHealth = new HealthStore();
    const accounts = new CredentialHealthStore();

    const err = await adapter
      .listModels!(ctx(NOT_A_KEY))
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(isMeridianError(err));

    // What the executor does with it, in the same order.
    accounts.recordFailure('cred_probe', 'google', err.code, err.message);
    const isAccountFault = err.code === 'authentication_failed';
    if (!isAccountFault) providerHealth.recordFailure('google', err.code, err.message);

    assert.equal(accounts.get('cred_probe').state, 'unauthorized', 'the account carries it');
    assert.equal(accounts.available('cred_probe'), false, 'and stops being offered');
    assert.equal(providerHealth.get('google').circuit, 'closed', 'the provider does not');
  });
});
