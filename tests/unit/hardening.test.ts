import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, isErrorCode, isFree, mayCharge, type Pricing } from '@meridian/shared';

const metered = (rates: Partial<Pick<Pricing, 'inputPerMTok' | 'outputPerMTok' | 'perRequest'>>): Pricing => ({
  kind: 'METERED',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: null,
  ...rates,
});

describe('isFree: unpublished rates are not free', () => {
  it('treats a metered model with no published rates as chargeable', () => {
    // The exact shape a discovered paid model has before anyone records its
    // price. Coalescing null to zero here let paid models through FREE routing.
    assert.equal(isFree(metered({})), false);
    assert.equal(mayCharge(metered({})), true);
  });

  it('still treats explicitly zero rates as free', () => {
    assert.equal(isFree(metered({ inputPerMTok: 0, outputPerMTok: 0 })), true);
    assert.equal(isFree(metered({ inputPerMTok: 0, outputPerMTok: 0, perRequest: 0 })), true);
  });

  it('one stated non-zero rate makes it chargeable regardless of the rest', () => {
    assert.equal(isFree(metered({ outputPerMTok: 15 })), false);
    assert.equal(isFree(metered({ inputPerMTok: 0, outputPerMTok: 15 })), false);
    assert.equal(isFree(metered({ perRequest: 0.04 })), false);
  });
});

describe('429 classification', () => {
  it('separates quota exhaustion from a rate limit', () => {
    // Same status, opposite handling: a rate limit clears on its own, an
    // exhausted quota does not, and retrying it burns the fallback budget.
    assert.equal(classifyStatus(429, 'You exceeded your current quota, please check your plan and billing details'), 'quota_exhausted');
    assert.equal(classifyStatus(429, 'insufficient_funds'), 'quota_exhausted');
    assert.equal(classifyStatus(429, 'Rate limit reached for requests'), 'rate_limited');
    assert.equal(classifyStatus(429, ''), 'rate_limited');
  });
});

describe('A dead key is a dead key, whatever status it arrives with', () => {
  it('reads Google’s 400 API_KEY_INVALID as an authentication failure', () => {
    // Verified against the live endpoint: `GET generativelanguage.googleapis.com
    // /v1beta/models` with a bad `x-goog-api-key` answers **400**, not 401,
    // with `"reason": "API_KEY_INVALID"`.
    //
    // Falling through to `invalid_request` was wrong three times over. The
    // caller was told their request was malformed when their key was dead;
    // `invalid_request` does not fail over, so the fallback chain stopped at
    // the first provider; and it is not an account fault, so the dead key was
    // never taken out of rotation and every later request repeated it.
    const google = JSON.stringify({
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
    });
    assert.equal(classifyStatus(400, google), 'authentication_failed');
  });

  it('reads the other spellings providers use', () => {
    assert.equal(classifyStatus(400, '{"error":{"message":"Invalid API key provided"}}'), 'authentication_failed');
    assert.equal(classifyStatus(400, '{"error":{"type":"authentication_error"}}'), 'authentication_failed');
    assert.equal(classifyStatus(400, '{"code":16,"message":"unauthenticated"}'), 'authentication_failed');
  });

  it('does not reclassify an ordinary bad request that mentions a key', () => {
    // The match has to be about a credential, not about the word "key".
    assert.equal(classifyStatus(400, '{"error":{"message":"Unknown key \'temprature\' in request body"}}'), 'invalid_request');
    assert.equal(classifyStatus(400, '{"error":{"message":"messages: field required"}}'), 'invalid_request');
  });
});

describe('isErrorCode', () => {
  it('accepts taxonomy codes and rejects everything else', () => {
    assert.equal(isErrorCode('rate_limited'), true);
    assert.equal(isErrorCode('cancelled'), true);
    assert.equal(isErrorCode('made_up_code'), false);
    assert.equal(isErrorCode(undefined), false);
  });
});
