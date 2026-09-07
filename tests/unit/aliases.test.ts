import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_ALIASES,
  isAlias,
  isUnknownMeridianAlias,
  resolveAlias,
} from '@meridian/shared';

/**
 * Dynamic aliases.
 *
 * The property that makes them worth having is that they name an intent and
 * resolve against the live route graph, so a client asking for the best free
 * coding model keeps getting the best one as the world changes. The property
 * that makes them safe is that they can narrow what is acceptable but never
 * widen what the operator permits.
 */

describe('recognition', () => {
  it('accepts every declared alias', () => {
    for (const a of MODEL_ALIASES) assert.equal(isAlias(a.id), true, a.id);
  });

  it('keeps the bare names older clients already send working', () => {
    for (const n of ['auto', 'meridian', 'default', 'AUTO']) {
      assert.equal(resolveAlias(n)?.id, 'meridian/auto', n);
    }
  });

  it('does not mistake a real model id for an alias', () => {
    assert.equal(isAlias('groq:llama-3.3-70b-versatile'), false);
    assert.equal(isAlias('gpt-4o'), false);
    assert.equal(resolveAlias('gpt-4o'), null);
    assert.equal(isAlias(null), false);
    assert.equal(isAlias(undefined), false);
  });

  it('flags a meridian/ name that is not a real alias', () => {
    // It must not quietly become AUTO. Someone asking for a free video model
    // that does not exist should be told, not handed a paid text model.
    assert.equal(isUnknownMeridianAlias('meridian/free-telepathy'), true);
    assert.equal(resolveAlias('meridian/free-telepathy'), null);
    assert.equal(isUnknownMeridianAlias('meridian/free'), false);
    assert.equal(isUnknownMeridianAlias('gpt-4o'), false, 'a normal id is not our problem');
  });
});

describe('constraints', () => {
  const byId = (id: string) => MODEL_ALIASES.find((a) => a.id === id)!;

  it('gates the free aliases on free-only rather than merely preferring it', () => {
    for (const id of ['meridian/free', 'meridian/free-coder', 'meridian/free-reasoning', 'meridian/free-vision', 'meridian/free-image']) {
      assert.equal(byId(id).freeOnly, true, id);
    }
  });

  it('gates the local alias on local-only', () => {
    assert.equal(byId('meridian/local').localOnly, true);
  });

  it('makes a capability alias a hard requirement', () => {
    assert.deepEqual(byId('meridian/free-vision').requiredCapabilities, ['vision']);
  });

  it('sends an image alias to the image modality', () => {
    assert.equal(byId('meridian/free-image').modality, 'image');
  });

  it('biases task aliases without pinning a model', () => {
    assert.equal(byId('meridian/free-coder').taskType, 'coding');
    assert.equal(byId('meridian/free-reasoning').taskType, 'reasoning');
  });

  it('NEVER lets an alias widen what the operator permits', () => {
    // The safety property. An alias is allowed to say "only free" or "only
    // local"; it is never allowed to say "paid is fine" on the operator's
    // behalf. allowPaid is not in the definition shape at all, and this test
    // exists so adding it would be a deliberate act rather than an accident.
    for (const a of MODEL_ALIASES) {
      assert.equal('allowPaid' in a, false, `${a.id} must not be able to authorise spending`);
      assert.equal('budget' in a, false, `${a.id} must not be able to set a budget`);
    }
  });

  it('resolves to no fixed model', () => {
    // An alias that carried a model id would be a hard-coded name with extra
    // steps — exactly the coupling it exists to remove.
    for (const a of MODEL_ALIASES) {
      assert.equal('model' in a, false, `${a.id} must not pin a model`);
      assert.equal('provider' in a, false, `${a.id} must not pin a provider`);
    }
  });
});

describe('catalogue', () => {
  it('gives every alias a namespaced id and a description', () => {
    for (const a of MODEL_ALIASES) {
      assert.match(a.id, /^meridian\//, a.id);
      assert.ok(a.description.length > 10, `${a.id} needs a real description`);
    }
  });

  it('has no duplicates', () => {
    const ids = MODEL_ALIASES.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('covers the intents the product promises', () => {
    const ids = new Set(MODEL_ALIASES.map((a) => a.id));
    for (const required of [
      'meridian/auto',
      'meridian/free',
      'meridian/cheapest',
      'meridian/best-value',
      'meridian/local',
      'meridian/fastest',
    ]) {
      assert.ok(ids.has(required), `missing ${required}`);
    }
  });
});
