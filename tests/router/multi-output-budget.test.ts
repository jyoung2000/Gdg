import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AIRequest, Pricing } from '@meridian/shared';
import { createHarness, model, provider } from '../helpers/harness.js';

/**
 * A request that produces n things must reserve n things' worth of budget.
 *
 * The routing estimate and the budget reservation both hard-coded one unit for
 * image and video work. So `n: 8` reserved one image's cost, cleared a budget
 * with room for one image, and then spent eight — and the same shape applied to
 * video, where a thirty-second clip reserved like a one-second one.
 *
 * This is a financial-correctness invariant rather than a nicety: the whole
 * point of a budget is that a call which would exceed it does not happen.
 */
describe('Budget reservation for multi-output requests', () => {
  /** $0.04 an image, the going rate for a mid-size model. */
  const PER_IMAGE: Pricing = { kind: 'PAID', inputPerMTok: null, outputPerMTok: null, perRequest: 0.04, note: null };

  const imageRequest = (units: number | undefined, budget: number): AIRequest => ({
    modality: 'image',
    taskType: 'image-generation',
    prompt: 'a cat',
    billableUnits: units,
    model: null,
    provider: null,
    pool: null,
    mode: 'AUTO',
    userId: null,
    workspaceId: null,
    allowPaid: true,
    budget,
  });

  const harness = () =>
    createHarness({
      allowPaid: true,
      media: true,
      providers: [provider({ id: 'pix' })],
      models: [
        model({
          id: 'pix:draw',
          providerId: 'pix',
          providerModelId: 'draw',
          modalities: ['image'],
          capabilities: ['image-generation'],
          pricing: PER_IMAGE,
        }),
      ],
    });

  it('reserves one image for a single-image request', () => {
    const decision = harness().router.route(imageRequest(1, 0.1));
    assert.ok(decision.model, 'a single image inside the budget must route');
    assert.ok(
      Math.abs((decision.reservationCost ?? 0) - 0.04) < 1e-9,
      `expected $0.04 reserved, got $${decision.reservationCost}`,
    );
  });

  it('reserves every image of a multi-image request', () => {
    const decision = harness().router.route(imageRequest(8, 1));
    assert.ok(decision.model, 'eight images inside a $1.00 budget must still route');
    assert.ok(
      Math.abs((decision.reservationCost ?? 0) - 0.32) < 1e-9,
      `eight images at $0.04 is $0.32, got $${decision.reservationCost}`,
    );
  });

  it('refuses a multi-image request the budget cannot cover', () => {
    // $0.10 covers two images, not eight. Before the fix this routed happily:
    // the estimate said $0.04, the budget said yes, and the call spent $0.32.
    assert.throws(
      () => harness().router.route(imageRequest(8, 0.1)),
      (e: Error) => {
        assert.match(e.message, /budget|No model/i, `expected a budget refusal, got: ${e.message}`);
        return true;
      },
      'a request for eight images must be measured against eight images',
    );
  });

  it('treats an absent or nonsensical count as exactly one', () => {
    // The field comes from a request body. Absent means one; a negative or
    // fractional value must not produce a reservation below one unit, and a
    // vast one must not be able to overflow the estimate into nonsense.
    for (const units of [undefined, 0, -5, Number.NaN] as (number | undefined)[]) {
      const decision = harness().router.route(imageRequest(units, 0.1));
      assert.ok(
        Math.abs((decision.reservationCost ?? 0) - 0.04) < 1e-9,
        `units=${String(units)} must reserve one image, got $${decision.reservationCost}`,
      );
    }
    const fractional = harness().router.route(imageRequest(2.3, 1));
    assert.ok(
      Math.abs((fractional.reservationCost ?? 0) - 0.12) < 1e-9,
      `a fractional count rounds up to whole units, got $${fractional.reservationCost}`,
    );
  });
});
