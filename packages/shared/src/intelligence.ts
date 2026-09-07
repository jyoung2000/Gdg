/**
 * Model intelligence: what Meridian knows about access, cost and provenance —
 * and, just as importantly, what it does not.
 *
 * The rule that shapes every type in this file: an absent fact is a fact. A
 * provider whose terms we have not read is `'unknown'`, never `'no'`; a model
 * with no observed latency is `null`, never `0`. Rendering "unknown" as a
 * definite answer is how a tool talks someone into spending money or breaching
 * a licence, so the tri-state is structural here rather than a convention.
 */

/* ------------------------------------------------------------------ */
/* Tri-state                                                           */
/* ------------------------------------------------------------------ */

/**
 * A yes/no that is allowed to not know.
 *
 * Deliberately three strings rather than `boolean | null`: at a call site,
 * `if (reqs.card)` silently treats unknown as false, whereas
 * `reqs.card === 'yes'` forces the author to decide what unknown means.
 */
export type Tristate = 'yes' | 'no' | 'unknown';

/** Normalise an upstream `true | false | null` into a {@link Tristate}. */
export function tristate(value: boolean | null | undefined): Tristate {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

/** True only when we positively know the answer is yes. Unknown is not yes. */
export function isDefinitelyYes(value: Tristate): boolean {
  return value === 'yes';
}

/** True only when we positively know the answer is no. Unknown is not no. */
export function isDefinitelyNo(value: Tristate): boolean {
  return value === 'no';
}

/* ------------------------------------------------------------------ */
/* Free access classification                                          */
/* ------------------------------------------------------------------ */

/**
 * The shape of free access.
 *
 * "$0 right now" is not one thing, and collapsing these into a single FREE
 * badge is the single most misleading thing a catalogue can do: a perpetual
 * free tier and a 30-day trial credit both cost nothing today and differ
 * completely in what they are worth to someone choosing a default model.
 */
export const FREE_ACCESS_KINDS = [
  /** No charge, no quota that resets — free as a standing property. */
  'FREE_FOREVER',
  /** A standing free allowance that renews (period unspecified). */
  'ONGOING_FREE_TIER',
  /** Free allowance that renews daily. */
  'FREE_DAILY_QUOTA',
  /** Free allowance that renews monthly. */
  'FREE_MONTHLY_QUOTA',
  /** One-off credit granted at signup. Runs out and does not come back. */
  'TRIAL_CREDIT',
  /** Credit granted again each period (e.g. monthly $5). */
  'RECURRING_CREDIT',
  /** Temporary promotion — free only until the provider ends it. */
  'PROMOTIONAL_FREE',
  /** Included in a subscription the operator already pays for. */
  'SUBSCRIPTION_INCLUDED',
  /** Metered, but below the operator's low-cost threshold. */
  'DISCOUNTED',
  /** Runs on the operator's hardware: no API charge, real electricity. */
  'LOCAL_ZERO_API_COST',
  /** Operator runs the weights themselves on infrastructure they chose. */
  'SELF_HOSTED',
  /** Costs money from the first token. */
  'PAID_ONLY',
  /** Not established. Never render this as free. */
  'UNKNOWN',
] as const;
export type FreeAccessKind = (typeof FREE_ACCESS_KINDS)[number];

/**
 * Kinds that cost the operator nothing at the moment of the call.
 *
 * Note what is absent: TRIAL_CREDIT and RECURRING_CREDIT are spending real
 * balance even though the invoice is zero, and SUBSCRIPTION_INCLUDED is money
 * already spent. Those are cheap, not free, and a "never pay" policy that
 * treated them as free would quietly burn a limited resource.
 */
export const ZERO_COST_ACCESS: readonly FreeAccessKind[] = [
  'FREE_FOREVER',
  'ONGOING_FREE_TIER',
  'FREE_DAILY_QUOTA',
  'FREE_MONTHLY_QUOTA',
  'PROMOTIONAL_FREE',
  'LOCAL_ZERO_API_COST',
  'SELF_HOSTED',
];

/** Does this access kind draw down a finite balance rather than renewing? */
export const DEPLETING_ACCESS: readonly FreeAccessKind[] = ['TRIAL_CREDIT'];

export function isZeroCost(kind: FreeAccessKind): boolean {
  return ZERO_COST_ACCESS.includes(kind);
}

/** Human label for a free-access kind. Kept next to the type so they agree. */
export function freeAccessLabel(kind: FreeAccessKind): string {
  switch (kind) {
    case 'FREE_FOREVER':
      return 'Free';
    case 'ONGOING_FREE_TIER':
      return 'Free tier';
    case 'FREE_DAILY_QUOTA':
      return 'Free daily quota';
    case 'FREE_MONTHLY_QUOTA':
      return 'Free monthly quota';
    case 'TRIAL_CREDIT':
      return 'Trial credit';
    case 'RECURRING_CREDIT':
      return 'Recurring credit';
    case 'PROMOTIONAL_FREE':
      return 'Promotional';
    case 'SUBSCRIPTION_INCLUDED':
      return 'In subscription';
    case 'DISCOUNTED':
      return 'Low cost';
    case 'LOCAL_ZERO_API_COST':
      return 'Local — no API cost';
    case 'SELF_HOSTED':
      return 'Self-hosted';
    case 'PAID_ONLY':
      return 'Paid';
    case 'UNKNOWN':
      return 'Unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Access requirements                                                 */
/* ------------------------------------------------------------------ */

/**
 * What a person has to hand over before they can use a provider at all.
 *
 * These gate adoption far more than price does — "free, but needs a credit
 * card" is a different product from "free, paste a key and go" — so they are
 * first-class and filterable rather than buried in a notes string.
 */
export interface AccessRequirements {
  /** Does a call need an API key? */
  apiKey: Tristate;
  /** Must the operator register an account? */
  account: Tristate;
  /** Must a payment card be on file, even for the free tier? */
  card: Tristate;
  /** Must a phone number be verified? */
  phone: Tristate;
}

export const UNKNOWN_REQUIREMENTS: AccessRequirements = {
  apiKey: 'unknown',
  account: 'unknown',
  card: 'unknown',
  phone: 'unknown',
};

/** True when nothing beyond an API key stands in the way — and we know it. */
export function isFrictionless(reqs: AccessRequirements): boolean {
  return reqs.card === 'no' && reqs.phone === 'no';
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where a claim came from.
 *
 * Every imported fact carries this so the UI can say "the dataset said so on
 * this date" rather than implying Meridian confirmed it. `VERIFIED` in this
 * codebase means someone can point at the check that produced it.
 */
export const SOURCE_TYPES = [
  /** A third-party machine-readable dataset. */
  'dataset',
  /** The provider's own API told us. */
  'provider-native',
  /** Shipped in Meridian's built-in catalog. */
  'builtin-catalog',
  /** The operator typed it in. */
  'user-configured',
  /** Meridian measured it here. */
  'measured',
  /** Inferred from a name or family — a guess, and labelled as one. */
  'heuristic',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How much weight a consumer should put on a claim. */
export type Confidence = 'high' | 'medium' | 'low';

export interface Provenance {
  /** Stable id of the source, e.g. `free-llm-api-hub`. */
  source: string;
  sourceType: SourceType;
  /** Where a human can go and check. */
  sourceUrl: string | null;
  /** Version of the source payload, when it publishes one. */
  sourceVersion: string | null;
  /**
   * Did the SOURCE claim independent verification? This is the source's claim
   * about itself, not Meridian's — never promote it to Meridian's own.
   */
  sourceVerified: boolean;
  /** How the claim was established, in words. */
  verificationMethod: string | null;
  /** Date the source last confirmed it (YYYY-MM-DD), when published. */
  lastVerified: string | null;
  confidence: Confidence;
  /** When Meridian imported it (epoch ms). Drives staleness display. */
  importedAt: number;
}

/**
 * Age of a claim in whole days, or null when the source published no date.
 * Null must render as "unknown", never as "fresh".
 */
export function provenanceAgeDays(p: Provenance, now: number): number | null {
  if (!p.lastVerified) return null;
  const t = Date.parse(p.lastVerified);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Data older than this reads as stale in the UI rather than current. */
export const STALE_AFTER_DAYS = 90;

export function isStale(p: Provenance, now: number): boolean {
  const age = provenanceAgeDays(p, now);
  return age === null ? true : age > STALE_AFTER_DAYS;
}

/* ------------------------------------------------------------------ */
/* Provider intelligence                                               */
/* ------------------------------------------------------------------ */

/**
 * The access/economics picture for one provider, kept beside the
 * ProviderDescriptor rather than inside it.
 *
 * Separate on purpose: the descriptor is what the router needs to make a call
 * and must stay small and stable, while this is editorial and imported data
 * that changes whenever a source is re-synced. Keeping them apart means a sync
 * can replace everything here without touching a working route.
 */
export interface ProviderIntelligence {
  providerId: string;
  freeAccess: FreeAccessKind;
  /** What you actually get for free, in concrete terms. */
  freeTierSummary: string | null;
  /** Published limits, as text — providers rarely express these uniformly. */
  rateLimitSummary: string | null;
  /** The fine print a builder needs before relying on this. */
  caveat: string | null;
  /** Editorial one-liner: when this is the right pick. */
  bestFor: string | null;
  /** Validity window for time-limited offers, e.g. "30 days". */
  expires: string | null;
  requirements: AccessRequirements;
  /** May outputs be used commercially? Unknown is the common, honest answer. */
  commercialUse: Tristate;
  /** Does the provider speak the OpenAI wire format? */
  openAiCompatible: Tristate;
  /** Base URL for a drop-in OpenAI-compatible call, when confirmed. */
  openAiBaseUrl: string | null;
  /** Model ids the source saw on the free tier. A sample, not a contract. */
  freeModelIds: string[];
  /** Modalities reachable on the free tier, as the source described them. */
  modalities: string[];
  provenance: Provenance;
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

/**
 * Live quota state, when a provider actually tells us.
 *
 * Every field is nullable because most providers publish nothing, and an
 * invented "100% remaining" is worse than an honest blank: it would let a
 * free-first policy keep choosing a route that is already exhausted.
 */
export interface QuotaState {
  providerId: string;
  modelId: string | null;
  requestsUsed: number | null;
  requestsLimit: number | null;
  tokensUsed: number | null;
  tokensLimit: number | null;
  /** Epoch ms when the window resets. */
  resetsAt: number | null;
  /** Where the numbers came from — headers, an API, or our own counting. */
  source: 'provider-headers' | 'provider-api' | 'local-accounting' | 'unknown';
  updatedAt: number;
}

/**
 * Fraction of quota left in [0,1], or null when genuinely unknown.
 *
 * Returns null rather than 1 when nothing is published: "we don't know" and
 * "it's full" must not be the same value to a router.
 */
export function quotaRemainingFraction(q: QuotaState): number | null {
  if (q.requestsLimit && q.requestsLimit > 0 && q.requestsUsed !== null) {
    return Math.max(0, Math.min(1, 1 - q.requestsUsed / q.requestsLimit));
  }
  if (q.tokensLimit && q.tokensLimit > 0 && q.tokensUsed !== null) {
    return Math.max(0, Math.min(1, 1 - q.tokensUsed / q.tokensLimit));
  }
  return null;
}

/** Known-exhausted. Unknown quota is never treated as exhausted. */
export function isQuotaExhausted(q: QuotaState): boolean {
  return quotaRemainingFraction(q) === 0;
}
