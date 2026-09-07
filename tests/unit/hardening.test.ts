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

describe('isErrorCode', () => {
  it('accepts taxonomy codes and rejects everything else', () => {
    assert.equal(isErrorCode('rate_limited'), true);
    assert.equal(isErrorCode('cancelled'), true);
    assert.equal(isErrorCode('made_up_code'), false);
    assert.equal(isErrorCode(undefined), false);
  });
});
