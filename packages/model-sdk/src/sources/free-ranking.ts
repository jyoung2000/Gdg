/**
 * Ranking free inference: which of these should you actually use?
 *
 * Discovery produces a list. A list is not an answer — "here are 202 models,
 * some of which may be free" is the problem restated, not solved. This turns it
 * into an order, and states the reason for each position so the order can be
 * argued with.
 *
 * The ranking is deliberately conservative in one direction. A model whose
 * status is unknown ranks below a model known to be paid, because an unknown
 * cost is a worse thing to route to by default than a known one: you can budget
 * for a price you know. Optimism about free tiers is how people get bills.
 */
import {
  isZeroCost,
  type FreeAccessKind,
  type Pricing,
  type Provenance,
} from '@meridian/shared';
import { STALE_AFTER_DAYS, confidenceRank, type ConfidenceLevel } from './types.js';
import type { MergedModel, MergedProvider } from './registry.js';

/* ------------------------------------------------------------------ */
/* What "free" means here                                              */
/* ------------------------------------------------------------------ */

export const FREE_VERDICTS = [
  /** Costs nothing per call, and the allowance renews. */
  'free',
  /** Costs nothing per call while a finite balance lasts. */
  'free-while-credit-lasts',
  /** Runs on the operator's own hardware: no invoice, real electricity. */
  'free-locally',
  /** Costs money. */
  'paid',
  /** Not established. Not free. */
  'unknown',
] as const;
export type FreeVerdict = (typeof FREE_VERDICTS)[number];

/**
 * Read a verdict from the two things that can speak to it.
 *
 * The rate card and the access kind can disagree, and when they do the more
 * pessimistic one wins. A `KNOWN_PAID` rate on a provider whose free tier a
 * community list asserts is a paid model at a provider that also has a free
 * tier — not a free model.
 */
export function freeVerdict(pricing: Pricing | undefined, access: FreeAccessKind | null): FreeVerdict {
  if (pricing?.kind === 'METERED' || pricing?.kind === 'PAID' || pricing?.kind === 'FLAT') return 'paid';
  if (
    pricing &&
    ((pricing.inputPerMTok !== null && pricing.inputPerMTok > 0) || (pricing.outputPerMTok !== null && pricing.outputPerMTok > 0))
  ) {
    return 'paid';
  }

  if (access === 'LOCAL_ZERO_API_COST' || access === 'SELF_HOSTED') return 'free-locally';
  if (access === 'TRIAL_CREDIT' || access === 'RECURRING_CREDIT') return 'free-while-credit-lasts';
  if (access && isZeroCost(access)) return 'free';
  if (access === 'PAID_ONLY' || access === 'DISCOUNTED' || access === 'SUBSCRIPTION_INCLUDED') return 'paid';

  // The rate card says zero and no source spoke to the access terms. A zero
  // rate is evidence, so this is 'free' — but only when the rate was actually
  // read, which `kind: 'FREE'` means and `kind: 'UNKNOWN'` does not.
  if (pricing?.kind === 'FREE' || pricing?.kind === 'FREE_DAILY' || pricing?.kind === 'FREE_MONTHLY') return 'free';
  if (pricing?.kind === 'LOCAL') return 'free-locally';

  return 'unknown';
}

export function isUsableForFree(verdict: FreeVerdict): boolean {
  return verdict === 'free' || verdict === 'free-locally';
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export interface RankedModel {
  modelId: string;
  providerId: string;
  providerModelId: string;
  verdict: FreeVerdict;
  score: number;
  /** Why it scored what it scored, in the order the components were applied. */
  reasons: string[];
  contextLength: number | null;
  capabilities: MergedModel['capabilities'];
  freeQuota: NonNullable<Pricing['freeQuota']> | null;
  confidence: ConfidenceLevel;
  ageDays: number | null;
  contributors: string[];
  provenance: Provenance;
  /** Set when the provider is registered and has a credential. */
  reachable: boolean | null;
}

export interface RankOptions {
  now: number;
  /** Capability every candidate must claim, e.g. `vision`. */
  requires?: (keyof NonNullable<MergedModel['capabilities']>)[];
  minContext?: number;
  /** Include everything, with verdicts, rather than only what is free. */
  includeNonFree?: boolean;
  /**
   * Whether Meridian could actually call this provider right now.
   *
   * A model that is free and unreachable is worth listing and worth ranking
   * below one that is free and configured — the operator can act on the first,
   * but only the second will serve a request today.
   */
  reachable?: (providerId: string) => boolean | null;
}

const DAY_MS = 86_400_000;

function ageOf(provenance: Provenance, now: number): number | null {
  if (!provenance.lastVerified) return null;
  const t = Date.parse(provenance.lastVerified);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * Score one model.
 *
 * The components, in descending weight:
 *
 *   verdict      1000  whether it costs anything is the question being asked
 *   confidence    100  how much the claim is worth
 *   freshness      60  a claim nobody rechecked is worth less, and is dated
 *   corroboration  25  two independent sources agreeing is evidence
 *   reachability   80  configured beats theoretical
 *   quota          40  a large published allowance beats a token one
 *   context        20  a tiebreak, not a ranking principle
 *
 * Nothing here rewards a model for being *called* free. Everything rewards it
 * for having evidence attached.
 */
export function scoreModel(
  model: MergedModel,
  provider: MergedProvider | undefined,
  opts: RankOptions,
): RankedModel {
  const access = provider?.intelligence?.freeAccess ?? null;
  const verdict = freeVerdict(model.pricing, access);
  const reasons: string[] = [];
  let score = 0;

  const verdictScore: Record<FreeVerdict, number> = {
    free: 1000,
    'free-locally': 900,
    'free-while-credit-lasts': 400,
    paid: 100,
    // Below paid, deliberately: an unknown cost is worse to default to than a
    // known one, because a known price can be budgeted for.
    unknown: 0,
  };
  score += verdictScore[verdict];
  reasons.push(`${verdict} (+${verdictScore[verdict]})`);

  const confidence = confidenceRank(model.confidence) * 25;
  score += confidence;
  reasons.push(`${model.confidence} claim (+${confidence})`);

  const ageDays = ageOf(model.provenance, opts.now);
  if (ageDays === null) {
    reasons.push('no date on the claim (+0)');
  } else if (ageDays <= STALE_AFTER_DAYS) {
    const freshness = Math.round(60 * (1 - ageDays / STALE_AFTER_DAYS));
    score += freshness;
    reasons.push(`checked ${ageDays}d ago (+${freshness})`);
  } else {
    reasons.push(`last checked ${ageDays}d ago — past the ${STALE_AFTER_DAYS}d staleness line (+0)`);
  }

  if (model.contributors.length > 1) {
    const corroboration = Math.min(25, (model.contributors.length - 1) * 15);
    score += corroboration;
    reasons.push(`${model.contributors.length} sources agree (+${corroboration})`);
  }

  const reachable = opts.reachable?.(model.providerId) ?? null;
  if (reachable === true) {
    score += 80;
    reasons.push('provider is configured here (+80)');
  } else if (reachable === false) {
    reasons.push('needs a credential before it can serve anything (+0)');
  }

  const quota = model.pricing?.freeQuota ?? null;
  if (quota) {
    // Log-scaled: the difference between 20 and 200 requests a day matters
    // much more than between 20,000 and 200,000.
    const perDay = quota.requestsPerDay ?? (quota.requestsPerMinute ? quota.requestsPerMinute * 60 * 24 : 0);
    const tokens = quota.tokensPerDay ?? 0;
    const magnitude = Math.max(perDay, tokens / 10_000);
    const points = magnitude > 0 ? Math.min(40, Math.round(Math.log10(magnitude + 1) * 12)) : 0;
    score += points;
    reasons.push(`published allowance (+${points})`);
  } else if (isUsableForFree(verdict)) {
    reasons.push('no published allowance, so how much is free is not known (+0)');
  }

  if (model.contextLength) {
    const points = Math.min(20, Math.round(Math.log10(model.contextLength) * 4));
    score += points;
    reasons.push(`${model.contextLength.toLocaleString('en-US')} token context (+${points})`);
  }

  return {
    modelId: model.modelId,
    providerId: model.providerId,
    providerModelId: model.providerModelId,
    verdict,
    score,
    reasons,
    contextLength: model.contextLength ?? null,
    capabilities: model.capabilities,
    freeQuota: quota,
    confidence: model.confidence,
    ageDays,
    contributors: model.contributors,
    provenance: model.provenance,
    reachable,
  };
}

export interface RankResult {
  models: RankedModel[];
  /** Candidates dropped, and why — so an empty result is explicable. */
  excluded: { reason: string; count: number }[];
}

export function rankFreeInference(
  models: MergedModel[],
  providers: MergedProvider[],
  opts: RankOptions,
): RankResult {
  const byId = new Map(providers.map((p) => [p.providerId, p]));
  const excluded = new Map<string, number>();
  const drop = (reason: string) => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);

  const ranked: RankedModel[] = [];
  for (const model of models) {
    const scored = scoreModel(model, byId.get(model.providerId), opts);

    if (!opts.includeNonFree && !isUsableForFree(scored.verdict)) {
      // Named separately from 'paid' on purpose: "we do not know" is a
      // different state from "it costs money", and collapsing them would hide
      // how much of the catalogue is unestablished.
      drop(scored.verdict === 'unknown' ? 'cost is not established' : `costs money (${scored.verdict})`);
      continue;
    }
    if (opts.minContext && (scored.contextLength ?? 0) < opts.minContext) {
      drop(`context below ${opts.minContext}`);
      continue;
    }
    if (opts.requires?.length) {
      const missing = opts.requires.filter((cap) => scored.capabilities?.[cap] !== true);
      if (missing.length) {
        // Absent is not false: a source that never mentioned vision has not
        // said the model lacks it. Excluding it is still right — a search for
        // vision models should not return maybes — but the reason has to say
        // which of the two it was, because "not claimed" is fixable by a probe
        // and "not supported" is not.
        drop(`does not claim ${missing.join(', ')}`);
        continue;
      }
    }
    ranked.push(scored);
  }

  ranked.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
  return {
    models: ranked,
    excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}
