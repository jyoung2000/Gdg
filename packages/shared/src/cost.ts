import type { Pricing, Usage } from './types.js';
import { NON_SPENDING_PRICING } from './types.js';

/** USD cost of a call, from token counts and the model's pricing. */
export function computeCost(pricing: Pricing, promptTokens: number, completionTokens: number, requests = 1): number {
  if (NON_SPENDING_PRICING.includes(pricing.kind)) return 0;
  let cost = 0;
  if (pricing.inputPerMTok != null) cost += (promptTokens / 1_000_000) * pricing.inputPerMTok;
  if (pricing.outputPerMTok != null) cost += (completionTokens / 1_000_000) * pricing.outputPerMTok;
  if (pricing.perRequest != null) cost += pricing.perRequest * requests;
  // Round to the nearest hundred-thousandth of a dollar; below that is noise.
  return Math.round(cost * 1e5) / 1e5;
}

/** True when routing to this model cannot draw down real money. */
export function isFree(pricing: Pricing): boolean {
  if (NON_SPENDING_PRICING.includes(pricing.kind)) return true;
  if (pricing.kind === 'METERED' || pricing.kind === 'PAID') {
    const rates = [pricing.inputPerMTok, pricing.outputPerMTok, pricing.perRequest];
    // Unpublished is not the same thing as zero. A metered model whose rates
    // are simply unknown can absolutely charge, and coalescing null to 0 here
    // let exactly those models through free-only routing and past the paid
    // gate. Free requires at least one rate stated, and every stated rate zero.
    if (rates.every((r) => r == null)) return false;
    return rates.every((r) => r == null || r === 0);
  }
  return false;
}

/**
 * True when the pricing represents money the operator may be charged, even if
 * a promotional balance currently covers it. TRIAL and CREDIT are deliberately
 * included: they expire, and treating them as permanently free misleads.
 */
export function mayCharge(pricing: Pricing): boolean {
  return !isFree(pricing);
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: Math.round((a.cost + b.cost) * 1e6) / 1e6,
  };
}

/**
 * Character-based token estimate. Used only for pre-flight budgeting when no
 * tokenizer is available for the target model; actual accounting always uses
 * provider-reported counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.7 chars/token is a good average across English prose and source code.
  return Math.ceil(text.length / 3.7);
}

/** Format USD for display. Sub-cent values keep enough precision to be useful. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
