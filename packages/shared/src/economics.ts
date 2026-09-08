/**
 * What a call costs, and — the part that decides whether a budget can bind —
 * whether that cost is actually known.
 *
 * `computeCost` answers "how much is this?" with a number. That is the right
 * shape for accounting a call that already happened, where the provider
 * reported the tokens and the rates were on file. It is the wrong shape for
 * every question asked *before* a call, because a metered model that publishes
 * no rate returns 0 from it, and 0 is indistinguishable from free.
 *
 * The consequence was not theoretical. Ranked by that number, an unpriced model
 * scored as the cheapest option available; checked against a budget, it fitted
 * every budget; charged to a pool, it consumed none of it. A model that could
 * bill any amount whatsoever won every cost-sensitive comparison precisely
 * because nothing was known about it.
 *
 * So this module answers with a value *and its epistemic status*. Unknown is a
 * first-class outcome that callers have to handle, which is the only way to
 * stop it from silently becoming zero.
 */
import type { CostBasis, CostClass, Pricing } from './types.js';
import { NON_SPENDING_PRICING } from './types.js';
import { isFree } from './cost.js';

export type { CostBasis, CostClass } from './types.js';

export interface CallEstimate {
  /** USD, or null when nothing applicable was published. Never 0 for unknown. */
  usd: number | null;
  /** True only when `usd` is the whole price rather than part of it. */
  known: boolean;
  basis: CostBasis;
  klass: CostClass;
  /** Rates the call needed and the provider did not publish. */
  missing: string[];
}

export interface CallShape {
  promptTokens: number;
  completionTokens: number;
  /** Requests billed at a flat per-request rate; 1 for an ordinary call. */
  requests?: number;
}

/**
 * Which side of the money question a model sits on.
 *
 * Note the ordering: "cannot charge" is decided by `isFree`, which already
 * refuses to read an unpublished rate as a zero one. Only models that survive
 * that check can be unknown, so a free model is never misfiled as unknown and
 * an unknown one is never misfiled as free.
 */
export function costClass(pricing: Pricing): CostClass {
  if (isFree(pricing)) return 'FREE';
  const rates = [pricing.inputPerMTok, pricing.outputPerMTok, pricing.perRequest];
  if (rates.every((r) => r == null)) return 'UNKNOWN_COST';
  return 'KNOWN_PAID';
}

/**
 * Estimate one call, keeping the difference between "zero" and "no idea".
 *
 * A rate counts as *needed* only when the call would actually be billed at it:
 * an output rate matters when output tokens are expected, and a per-request
 * rate matters when the call is billed that way — which is what a call with no
 * token counts at all (an image, a video) is. Treating a null `perRequest` as
 * missing on an ordinary token-metered call would mark almost every rate card
 * incomplete and make the distinction useless.
 */
export function estimateCall(pricing: Pricing, shape: CallShape): CallEstimate {
  const requests = shape.requests ?? 1;
  const klass = costClass(pricing);

  if (NON_SPENDING_PRICING.includes(pricing.kind) || klass === 'FREE') {
    // Free is a price, and it is known. Saying so lets a budget check pass a
    // free model without having to special-case it.
    return { usd: 0, known: true, basis: 'exact', klass: 'FREE', missing: [] };
  }

  const perRequestBilled = shape.promptTokens === 0 && shape.completionTokens === 0;
  const needed: { label: string; rate: number | null; quantity: number }[] = [];
  if (shape.promptTokens > 0) {
    needed.push({ label: 'input tokens', rate: pricing.inputPerMTok, quantity: shape.promptTokens / 1_000_000 });
  }
  if (shape.completionTokens > 0) {
    needed.push({ label: 'output tokens', rate: pricing.outputPerMTok, quantity: shape.completionTokens / 1_000_000 });
  }
  if (perRequestBilled) {
    needed.push({ label: 'per request', rate: pricing.perRequest, quantity: requests });
  }

  let total = 0;
  let anyPublished = false;
  const missing: string[] = [];
  for (const part of needed) {
    if (part.rate == null) {
      missing.push(part.label);
      continue;
    }
    anyPublished = true;
    total += part.rate * part.quantity;
  }

  // An ordinary token call may also carry a flat per-request fee. A null there
  // means "not billed that way", not "unpublished", so it adds nothing and
  // makes nothing incomplete.
  if (!perRequestBilled && pricing.perRequest != null) {
    anyPublished = true;
    total += pricing.perRequest * requests;
  }

  if (!anyPublished) {
    return { usd: null, known: false, basis: 'unknown', klass: 'UNKNOWN_COST', missing };
  }

  const rounded = Math.round(total * 1e5) / 1e5;
  return missing.length
    ? { usd: rounded, known: false, basis: 'lower_bound', klass, missing }
    : { usd: rounded, known: true, basis: 'exact', klass, missing: [] };
}

/**
 * Can this call be proven to fit an upper limit?
 *
 * Three answers, and the third is why this exists. A price that is not fully
 * known cannot clear a limit, because the part nobody published could be any
 * size at all — so the honest verdict is "unprovable", and a caller enforcing a
 * budget has to treat that as a refusal rather than as a pass.
 */
export function fitsLimit(estimate: CallEstimate, limit: number): { fits: boolean; provable: boolean; reason: string | null } {
  if (estimate.known && estimate.usd != null) {
    return estimate.usd <= limit
      ? { fits: true, provable: true, reason: null }
      : { fits: false, provable: true, reason: `estimated $${estimate.usd.toFixed(4)} exceeds the $${limit.toFixed(4)} limit` };
  }
  // A floor above the limit is already disqualifying, and saying so is more
  // useful than the generic unknown-price message.
  if (estimate.usd != null && estimate.usd > limit) {
    return {
      fits: false,
      provable: true,
      reason: `costs at least $${estimate.usd.toFixed(4)}, which already exceeds the $${limit.toFixed(4)} limit`,
    };
  }
  const detail = estimate.missing.length ? ` (no published rate for ${estimate.missing.join(' or ')})` : '';
  return {
    fits: false,
    provable: false,
    reason: `price is unknown${detail}, so it cannot be shown to fit the $${limit.toFixed(4)} limit`,
  };
}

/**
 * A ranking score in [0,1] where 1 is cheapest, or null when the price is not
 * fully known.
 *
 * Null rather than 0 so the caller has to decide what an unknown price means in
 * its own ranking, instead of inheriting a number that reads like a real one.
 * Cost is compared on a log scale because the gap between $0.0001 and $0.001
 * matters as much as the gap between $0.01 and $0.1.
 */
export function costScore(estimate: CallEstimate): number | null {
  if (!estimate.known || estimate.usd == null) return null;
  if (estimate.usd <= 0) return 1;
  const scaled = 1 - Math.log10(estimate.usd * 10_000 + 1) / 4;
  return Math.min(1, Math.max(0, scaled));
}

/** Human phrasing for a cost that may not exist. Used by the UI and the CLI. */
export function describeCost(estimate: CallEstimate): string {
  if (estimate.klass === 'FREE') return 'free';
  if (estimate.usd == null) return 'price not published';
  const money = estimate.usd < 0.01 ? `$${estimate.usd.toFixed(4)}` : `$${estimate.usd.toFixed(2)}`;
  return estimate.known ? money : `at least ${money}`;
}
