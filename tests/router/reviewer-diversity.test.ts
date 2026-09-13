import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, credential, model, provider } from '../helpers/harness.js';
import type { AIRequest } from '@meridian/shared';

/**
 * Routing away from the model that wrote the code.
 *
 * A model checking its own work agrees with itself. Meridian had no way to
 * express "not that one" at all: `AIRequest` carried no exclusion, so a
 * reviewer step could only ever be routed by the same scoring that picked the
 * implementer — and a global preferred-model setting made that a certainty.
 *
 * The rule is a preference rather than a constraint on purpose. A review that
 * cannot run is worse than a review by the same model, so the last resort is
 * to use it and say so.
 */

const REQUEST = (avoid?: string[]): AIRequest => ({
  taskType: 'coding',
  modality: 'text',
  messages: [{ role: 'user', content: 'review this' }],
  ...(avoid ? { avoidModels: avoid } : {}),
});

function twoModels() {
  return createHarness({
    providers: [provider({ id: 'alpha' }), provider({ id: 'beta' })],
    models: [
      model({ id: 'alpha:one', providerId: 'alpha', providerModelId: 'one' }),
      model({ id: 'beta:two', providerId: 'beta', providerModelId: 'two' }),
    ],
    credentials: [credential({ id: 'ka', providerId: 'alpha' }), credential({ id: 'kb', providerId: 'beta' })],
  });
}

describe('Routing away from a model', () => {
  it('picks something else when there is something else', () => {
    const h = twoModels();
    const first = h.router.route(REQUEST()).model;
    const second = h.router.route(REQUEST([`${first === 'one' ? 'alpha:one' : 'beta:two'}`])).model;
    assert.notEqual(second, first, 'the avoided model was chosen anyway');
  });

  it('serves the request anyway when there is nothing else, and says so', () => {
    const h = createHarness({
      providers: [provider({ id: 'only' })],
      models: [model({ id: 'only:one', providerId: 'only', providerModelId: 'one' })],
      credentials: [credential({ id: 'k', providerId: 'only' })],
    });

    const decision = h.router.route(REQUEST(['only:one']));
    assert.equal(decision.model, 'one', 'a review that cannot run is worse than a review by the same model');

    const criterion = decision.routingReason.criteria.find((c) => c.label.includes('route elsewhere'));
    assert.ok(criterion, 'the routing reason never mentions that the preference could not be honoured');
    assert.equal(criterion.met, false);
  });

  it('outranks a global preferred-model instruction for this one request', () => {
    // The half of this that made it unenforceable rather than merely absent: a
    // pinned favourite sorted first no matter what a step asked for, so every
    // step of a pipeline went to the same model however loudly a reviewer
    // asked for a different one.
    const h = createHarness({
      providers: [provider({ id: 'alpha' }), provider({ id: 'beta' })],
      models: [
        model({ id: 'alpha:one', providerId: 'alpha', providerModelId: 'one' }),
        model({ id: 'beta:two', providerId: 'beta', providerModelId: 'two' }),
      ],
      credentials: [credential({ id: 'ka', providerId: 'alpha' }), credential({ id: 'kb', providerId: 'beta' })],
      preferences: { preferredModels: ['alpha:one'] },
    });

    assert.equal(h.router.route(REQUEST()).model, 'one', 'the preference should win when nothing objects');
    assert.equal(h.router.route(REQUEST(['alpha:one'])).model, 'two', 'the pinned model was chosen despite the request');
  });
});
