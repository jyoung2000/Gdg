/**
 * Community free-model registries.
 *
 * Two of the maintained "awesome free LLM API" lists publish machine-readable
 * data rather than only prose, and they are complementary to the provider
 * dataset Meridian already syncs:
 *
 * - `mnfst/awesome-free-llm-apis` ships `data.json`: providers with a base URL
 *   and a per-model list carrying context window, max output, modality and a
 *   rate-limit string. Model-level detail the provider dataset does not have.
 *
 * - `uzair004/awesome-free-llm-apis` ships `providers/*.json`: fewer providers,
 *   but with free-tier limits as STRUCTURED NUMBERS (rpm, rpd, tpd) rather than
 *   prose, plus the names of the provider's rate-limit response headers.
 *
 * The structured limits matter more than the count. Meridian's `Pricing`
 * already has a `freeQuota` field with exactly those units, and nothing has
 * ever populated it — so a free tier could be labelled FREE_DAILY_QUOTA with no
 * way to say how large the allowance is. These sources fill that in with real
 * numbers instead of an adjective.
 *
 * Both are treated as community catalogues, which is the second-lowest rung of
 * the precedence ladder: they lose to the provider's own API, to a live check
 * and to the verified dataset. They are discovery signals, not authority.
 */
import { z } from 'zod';
import {
  tristate,
  type Pricing,
  type Provenance,
  type ProviderIntelligence,
} from '@meridian/shared';
import type { ConfidenceLevel, SourceMetadata } from './types.js';

/* ------------------------------------------------------------------ */
/* mnfst/awesome-free-llm-apis                                         */
/* ------------------------------------------------------------------ */

export const MNFST_SOURCE_ID = 'awesome-free-llm-apis-mnfst';
export const MNFST_URL =
  'https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/data.json';

const mnfstModelSchema = z
  .object({
    // Nullable because the real dataset has entries with no id. A model that
    // cannot be named cannot be routed to, so those are dropped rather than
    // rejected — one malformed row must not cost the whole catalogue.
    id: z.string().nullable(),
    name: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    maxOutput: z.string().nullable().optional(),
    modality: z.string().nullable().optional(),
    rateLimit: z.string().nullable().optional(),
  })
  .passthrough();

const mnfstProviderSchema = z
  .object({
    name: z.string(),
    category: z.string().optional(),
    url: z.string().nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    models: z.array(mnfstModelSchema).optional(),
  })
  .passthrough();

export const mnfstSchema = z.object({
  lastUpdated: z.string().optional(),
  providers: z.array(mnfstProviderSchema).min(1),
});

export type MnfstDataset = z.infer<typeof mnfstSchema>;
export type MnfstProvider = z.infer<typeof mnfstProviderSchema>;

/** Models the source actually named. An unnamed row cannot be routed to. */
export function namedModels(p: MnfstProvider): { id: string; context?: string | null; maxOutput?: string | null; modality?: string | null; rateLimit?: string | null }[] {
  return (p.models ?? []).filter((m): m is typeof m & { id: string } => typeof m.id === 'string' && m.id.length > 0);
}

/**
 * Parse a human context string like "128K" or "1M" into tokens.
 *
 * Returns null rather than guessing on anything unrecognised: a context window
 * that is wrong is worse than one that is absent, because a request sized
 * against it fails at the provider with an error the user cannot explain.
 */
export function parseTokenCount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = /^\s*([\d.]+)\s*([kKmM])?\s*$/.exec(raw.replace(/[, ]/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === 'k') return Math.round(n * 1_000);
  if (unit === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Pull structured limits out of a rate-limit sentence.
 *
 * Handles the forms these lists actually use — "15 RPM, 20K TPD",
 * "5 RPM / 100 RPD" — and returns only what it recognised. A sentence it cannot
 * parse yields an empty object, not zeroes.
 */
export function parseRateLimitText(raw: string | undefined | null): NonNullable<Pricing['freeQuota']> {
  const out: NonNullable<Pricing['freeQuota']> = {};
  if (!raw) return out;
  const text = raw.toUpperCase().replace(/,/g, '');
  const num = (v: string): number | null => {
    const m = /^([\d.]+)([KM])?$/.exec(v);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return m[2] === 'K' ? n * 1_000 : m[2] === 'M' ? n * 1_000_000 : n;
  };
  for (const [, value, unit] of text.matchAll(/([\d.]+[KM]?)\s*(RPM|RPD|TPM|TPD)/g)) {
    const n = num(value);
    if (n === null) continue;
    if (unit === 'RPM') out.requestsPerMinute = n;
    if (unit === 'RPD') out.requestsPerDay = n;
    if (unit === 'TPM') out.tokensPerMinute = n;
    if (unit === 'TPD') out.tokensPerDay = n;
  }
  return out;
}

/** A provider slug Meridian can compare against, from a display name. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ */
/* uzair004/awesome-free-llm-apis                                      */
/* ------------------------------------------------------------------ */

export const UZAIR_SOURCE_ID = 'awesome-free-llm-apis-uzair';
/** The repository publishes one file per provider under `providers/`. */
export const UZAIR_INDEX_URL =
  'https://api.github.com/repos/uzair004/awesome-free-llm-apis/contents/providers';

const uzairModelSchema = z
  .object({
    id: z.string(),
    free: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    tier: z.string().optional(),
    contextWindow: z.number().optional(),
    maxOutputTokens: z.number().optional(),
  })
  .passthrough();

export const uzairProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string().optional(),
    signupUrl: z.string().optional(),
    docsUrl: z.string().optional(),
    auth: z.object({ envVar: z.string().optional(), header: z.string().optional() }).partial().optional(),
    freeTier: z
      .object({
        type: z.string().optional(),
        limits: z
          .object({
            rpm: z.number().optional(),
            rpd: z.number().optional(),
            tpm: z.number().optional(),
            tpd: z.number().optional(),
          })
          .partial()
          .optional(),
        credits: z.string().optional(),
        expiresAfterDays: z.number().optional(),
        notes: z.string().optional(),
      })
      .partial()
      .optional(),
    /** Header names for reading remaining quota — see the note below. */
    rateLimitHeaders: z
      .object({ remaining: z.string().optional(), reset: z.string().optional(), limit: z.string().optional() })
      .partial()
      .optional(),
    models: z.array(uzairModelSchema).optional(),
    notes: z.array(z.string()).optional(),
    lastVerified: z.string().optional(),
    verifiedBy: z.string().optional(),
  })
  .passthrough();

export type UzairProvider = z.infer<typeof uzairProviderSchema>;

/**
 * Rate-limit header names, kept for the quota work that is not built yet.
 *
 * Meridian's `QuotaState` is defined and honest — it returns null rather than
 * 1 when nothing is published — but nothing constructs one, because no adapter
 * reads quota out of a response. These names are what that work will need when
 * it happens, so they are carried through and stored rather than dropped; they
 * are recorded as metadata and are NOT presented as live quota.
 */
export function rateLimitHeaderNames(p: UzairProvider): { remaining: string | null; reset: string | null; limit: string | null } {
  return {
    remaining: p.rateLimitHeaders?.remaining ?? null,
    reset: p.rateLimitHeaders?.reset ?? null,
    limit: p.rateLimitHeaders?.limit ?? null,
  };
}

/** Structured free-tier limits, in Meridian's own units. */
export function freeQuotaOf(p: UzairProvider): Pricing['freeQuota'] {
  const l = p.freeTier?.limits;
  if (!l) return null;
  const q: NonNullable<Pricing['freeQuota']> = {};
  if (typeof l.rpm === 'number') q.requestsPerMinute = l.rpm;
  if (typeof l.rpd === 'number') q.requestsPerDay = l.rpd;
  if (typeof l.tpm === 'number') q.tokensPerMinute = l.tpm;
  if (typeof l.tpd === 'number') q.tokensPerDay = l.tpd;
  return Object.keys(q).length ? q : null;
}

/* ------------------------------------------------------------------ */
/* Shared metadata                                                     */
/* ------------------------------------------------------------------ */

export const MNFST_METADATA: SourceMetadata = {
  id: MNFST_SOURCE_ID,
  displayName: 'awesome-free-llm-apis (mnfst)',
  url: 'https://github.com/mnfst/awesome-free-llm-apis',
  license: 'CC0-1.0',
  attribution: 'Model listings from github.com/mnfst/awesome-free-llm-apis (CC0 1.0).',
  sourceClass: 'community-catalog',
  // A community list with a lastUpdated stamp and no per-entry verification.
  baseConfidence: 'UNVERIFIED',
  contributes: ['providers', 'models', 'limits', 'quota'],
};

export const UZAIR_METADATA: SourceMetadata = {
  id: UZAIR_SOURCE_ID,
  displayName: 'awesome-free-llm-apis (uzair004)',
  url: 'https://github.com/uzair004/awesome-free-llm-apis',
  license: 'CC0-1.0',
  attribution: 'Free-tier limits from github.com/uzair004/awesome-free-llm-apis (CC0 1.0).',
  sourceClass: 'community-catalog',
  // Entries carry lastVerified and verifiedBy, so a dated one can reach LIKELY;
  // ageAdjusted() drops it back to STALE once the date is old enough.
  baseConfidence: 'LIKELY',
  // 'capabilities' is here because the source genuinely publishes per-model
  // capability lists — tools, structured output, reasoning. It was missing, and
  // the effect was not a type error but a silent one: the merge refused thirty
  // capability claims a source was entitled to make, and the models came out
  // looking less capable than the data said they were. `contributes` is load-
  // bearing, so it has to describe what the parser actually reads.
  contributes: ['providers', 'models', 'limits', 'capabilities', 'access-terms', 'quota'],
};

export function communityProvenance(
  sourceId: string,
  url: string,
  lastVerified: string | null,
  now: number,
): Provenance {
  return {
    source: sourceId,
    sourceType: 'dataset',
    sourceUrl: url,
    sourceVersion: null,
    sourceVerified: Boolean(lastVerified),
    verificationMethod: lastVerified
      ? 'Community catalogue entry carrying its own verification date.'
      : 'Community catalogue entry with no verification date.',
    lastVerified,
    // A community list is never better than low confidence on its own. It is a
    // discovery signal that something might be free, not evidence that it is.
    confidence: 'low',
    importedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Intelligence from a uzair004 provider entry.
 *
 * Note what is NOT asserted. This source says nothing about card or phone
 * requirements or commercial use, so those stay `'unknown'` rather than being
 * filled with a cheerful default — the verified dataset is the source that
 * speaks to those, and where it does, its answer wins.
 */
export function uzairIntelligence(p: UzairProvider, now: number): ProviderIntelligence {
  const limits = freeQuotaOf(p);
  const summaryParts: string[] = [];
  if (limits?.requestsPerMinute) summaryParts.push(`${limits.requestsPerMinute} req/min`);
  if (limits?.requestsPerDay) summaryParts.push(`${limits.requestsPerDay} req/day`);
  if (limits?.tokensPerDay) summaryParts.push(`${limits.tokensPerDay.toLocaleString()} tokens/day`);

  return {
    providerId: p.id,
    freeAccess:
      p.freeTier?.type === 'perpetual'
        ? 'FREE_FOREVER'
        : p.freeTier?.type === 'trial'
          ? 'TRIAL_CREDIT'
          : 'UNKNOWN',
    freeTierSummary: summaryParts.join(', ') || p.freeTier?.notes || null,
    rateLimitSummary: summaryParts.join(', ') || null,
    caveat: p.freeTier?.notes ?? null,
    bestFor: null,
    expires: typeof p.freeTier?.expiresAfterDays === 'number' ? `${p.freeTier.expiresAfterDays} days` : null,
    requirements: {
      apiKey: p.auth?.envVar ? 'yes' : 'unknown',
      account: 'unknown',
      // This source does not track these. Unknown is the honest answer.
      card: tristate(null),
      phone: tristate(null),
    },
    commercialUse: tristate(null),
    openAiCompatible: tristate(null),
    openAiBaseUrl: null,
    freeModelIds: (p.models ?? []).filter((m) => m.free !== false).map((m) => m.id),
    modalities: [...new Set((p.models ?? []).flatMap((m) => m.capabilities ?? []))],
    provenance: communityProvenance(UZAIR_SOURCE_ID, UZAIR_METADATA.url, p.lastVerified ?? null, now),
  };
}

export function uzairConfidence(p: UzairProvider): ConfidenceLevel {
  return p.lastVerified ? 'LIKELY' : 'UNVERIFIED';
}
