/**
 * Importer for the free-llm-api-hub dataset.
 *
 * Upstream: https://github.com/pacocartones/free-llm-api-hub (MIT).
 * The dataset is a curated, versioned, machine-readable record of providers
 * that offer free tiers or trial credit, with the fine print — card and phone
 * requirements, commercial-use permission, OpenAI-compatible base URLs — that
 * a catalogue normally leaves out.
 *
 * Three deliberate choices govern this file.
 *
 * First, this is a SYNCHRONISER, not a snapshot. Nothing here hard-codes a
 * provider. The dataset is fetched, validated against its published schema,
 * and normalised; if upstream adds a provider tomorrow, Meridian picks it up
 * without a code change. A vendored copy exists only as an offline fallback and
 * is clearly labelled as such.
 *
 * Second, the upstream tri-state survives. The dataset writes `null` for "not
 * yet confirmed" and Meridian carries that through as `'unknown'` rather than
 * defaulting it to false. A provider that has not been confirmed card-free is
 * not advertised as card-free.
 *
 * Third, an imported provider is a CLAIM, not a verification. Everything
 * carries {@link Provenance} naming the dataset, its version and the date it
 * last checked, and imported providers enter with `trust: 'unknown'`. Meridian
 * says "the dataset said so on this date", never "Meridian verified this".
 */
import { z } from 'zod';
import {
  tristate,
  type AccessRequirements,
  type FreeAccessKind,
  type Pricing,
  type PricingKind,
  type Provenance,
  type ProviderDescriptor,
  type ProviderIntelligence,
  type ProviderKind,
} from '@meridian/shared';

/* ------------------------------------------------------------------ */
/* Upstream schema                                                     */
/* ------------------------------------------------------------------ */

/** `true | false | null`, where null means "not yet confirmed" upstream. */
const upstreamTristate = z.boolean().nullable().optional();

/**
 * Mirrors data/schema.json in the upstream repository.
 *
 * Unknown keys are allowed through rather than rejected: upstream adds fields
 * as the dataset grows, and a new column must not turn into a failed sync that
 * strands the operator on stale data.
 */
const providerEntrySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(['ongoing', 'trial']),
    free_type: z.enum(['perpetual', 'renewing-quota', 'recurring-credit', 'trial-credit']),
    free_tier: z.string(),
    rate_limits: z.string().optional(),
    notes: z.string().optional(),
    best_for: z.string().nullable().optional(),
    modalities: z.array(z.string()).optional(),
    models_free: z.array(z.string()).nullable().optional(),
    expires: z.string().nullable().optional(),
    docs_url: z.string(),
    phone_required: upstreamTristate,
    card_required: upstreamTristate,
    commercial_ok: upstreamTristate,
    openai_compatible: upstreamTristate,
    openai_base_url: z.string().nullable().optional(),
    env_key: z.string().optional(),
    verified: z.boolean(),
    last_verified: z.string().nullable().optional(),
    added: z.string().optional(),
  })
  .passthrough();

export const freeLlmHubDatasetSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  generated: z.string(),
  source: z.string().optional(),
  note: z.string().optional(),
  providers: z.array(providerEntrySchema).min(1),
});

export type FreeLlmHubDataset = z.infer<typeof freeLlmHubDatasetSchema>;
export type FreeLlmHubProvider = z.infer<typeof providerEntrySchema>;

/* ------------------------------------------------------------------ */
/* Source identity                                                     */
/* ------------------------------------------------------------------ */

export const SOURCE_ID = 'free-llm-api-hub';
export const SOURCE_REPO = 'https://github.com/pacocartones/free-llm-api-hub';
export const SOURCE_LICENSE = 'MIT';
export const DEFAULT_DATASET_URL =
  'https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json';

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turn the dataset's `free_type` into Meridian's access taxonomy.
 *
 * `renewing-quota` is the one that needs care: upstream does not say what the
 * period is, so the period is read from the limits text when it states one and
 * left as a generic ongoing tier when it does not. Guessing "daily" for a
 * monthly allowance would misreport the size of the free tier by 30x.
 */
export function classifyFreeAccess(entry: FreeLlmHubProvider): FreeAccessKind {
  switch (entry.free_type) {
    case 'perpetual':
      return 'FREE_FOREVER';
    case 'trial-credit':
      return 'TRIAL_CREDIT';
    case 'recurring-credit':
      return 'RECURRING_CREDIT';
    case 'renewing-quota': {
      const limits = `${entry.rate_limits ?? ''} ${entry.free_tier}`.toLowerCase();
      // RPD / "per day" / "daily" are the forms the dataset actually uses.
      if (/\brpd\b|per day|\/day|daily/.test(limits)) return 'FREE_DAILY_QUOTA';
      if (/per month|\/month|monthly|\brpm\b\s*month/.test(limits)) return 'FREE_MONTHLY_QUOTA';
      return 'ONGOING_FREE_TIER';
    }
  }
}

/**
 * The pricing posture that matches an access kind.
 *
 * Follows the catalog's existing rule: a rate-limited allowance is FREE_DAILY,
 * never FREE. Rates stay null — this dataset records the shape of the free
 * tier, not a rate card, and inventing numbers would be worse than a blank.
 */
export function pricingForAccess(kind: FreeAccessKind, note: string | null): Pricing {
  const map: Record<string, PricingKind> = {
    FREE_FOREVER: 'FREE',
    FREE_DAILY_QUOTA: 'FREE_DAILY',
    FREE_MONTHLY_QUOTA: 'FREE_MONTHLY',
    ONGOING_FREE_TIER: 'FREE_DAILY',
    TRIAL_CREDIT: 'TRIAL',
    RECURRING_CREDIT: 'CREDIT',
  };
  return {
    kind: map[kind] ?? 'UNKNOWN',
    inputPerMTok: null,
    outputPerMTok: null,
    perRequest: null,
    note,
  };
}

/** Dataset modalities → Meridian provider kinds. */
export function kindsForModalities(modalities: string[]): ProviderKind[] {
  const kinds = new Set<ProviderKind>();
  for (const m of modalities) {
    switch (m) {
      case 'text':
        kinds.add('llm');
        kinds.add('coding');
        break;
      case 'vision':
        kinds.add('llm');
        break;
      case 'image':
        kinds.add('image');
        break;
      case 'audio':
        kinds.add('audio');
        break;
      case 'embeddings':
        kinds.add('embedding');
        break;
      default:
        break;
    }
  }
  if (kinds.size === 0) kinds.add('llm');
  return [...kinds];
}

/**
 * A base URL the operator still has to fill in, e.g. one containing
 * `{account_id}`.
 *
 * These cannot be called as-is, so they must not be registered as though they
 * were working endpoints — that is precisely the "configured but not connected"
 * state the product forbids presenting as ready.
 */
export function needsOperatorConfig(baseUrl: string | null | undefined): boolean {
  return typeof baseUrl === 'string' && /\{[^}]+\}/.test(baseUrl);
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

export interface NormalizedProvider {
  /** Present only when the entry can back a real, callable route. */
  descriptor: ProviderDescriptor | null;
  intelligence: ProviderIntelligence;
  /** Why no descriptor was produced, when there is none. */
  unroutableReason: string | null;
}

function provenanceFor(entry: FreeLlmHubProvider, dataset: FreeLlmHubDataset, now: number): Provenance {
  return {
    source: SOURCE_ID,
    sourceType: 'dataset',
    sourceUrl: entry.docs_url || SOURCE_REPO,
    sourceVersion: dataset.version,
    sourceVerified: entry.verified,
    verificationMethod: entry.verified
      ? 'Upstream dataset confirmed the core facts against the provider’s own documentation.'
      : 'Community-tracked upstream; not independently confirmed.',
    lastVerified: entry.last_verified ?? null,
    // The dataset's own verification is good evidence, but it is still someone
    // else's reading of the provider's docs on a past date — never "high".
    confidence: entry.verified ? 'medium' : 'low',
    importedAt: now,
  };
}

export function requirementsFor(entry: FreeLlmHubProvider): AccessRequirements {
  return {
    // A published env var name is the dataset's way of saying "key needed".
    apiKey: entry.env_key ? 'yes' : 'unknown',
    // Every provider in this dataset is an account-based API service; the
    // dataset does not track this separately, so it stays unknown rather than
    // being asserted from the presence of a key.
    account: 'unknown',
    card: tristate(entry.card_required),
    phone: tristate(entry.phone_required),
  };
}

/**
 * Normalise one dataset entry.
 *
 * `existingIds` are the providers Meridian already ships. A dataset entry that
 * matches one of them contributes intelligence only: the shipped descriptor is
 * hand-written, adapter-backed and already working, and replacing it with an
 * imported guess would be a downgrade.
 */
export function normalizeEntry(
  entry: FreeLlmHubProvider,
  dataset: FreeLlmHubDataset,
  opts: { now: number; existingIds: ReadonlySet<string> },
): NormalizedProvider {
  const freeAccess = classifyFreeAccess(entry);
  const provenance = provenanceFor(entry, dataset, opts.now);
  const modalities = entry.modalities ?? [];

  const intelligence: ProviderIntelligence = {
    providerId: entry.slug,
    freeAccess,
    freeTierSummary: entry.free_tier || null,
    rateLimitSummary: entry.rate_limits ?? null,
    caveat: entry.notes ?? null,
    bestFor: entry.best_for ?? null,
    expires: entry.expires ?? null,
    requirements: requirementsFor(entry),
    commercialUse: tristate(entry.commercial_ok),
    openAiCompatible: tristate(entry.openai_compatible),
    openAiBaseUrl: entry.openai_base_url ?? null,
    freeModelIds: entry.models_free ?? [],
    modalities,
    provenance,
  };

  if (opts.existingIds.has(entry.slug)) {
    return { descriptor: null, intelligence, unroutableReason: 'already-shipped' };
  }
  if (entry.openai_compatible !== true || !entry.openai_base_url) {
    return {
      descriptor: null,
      intelligence,
      unroutableReason: 'no-openai-compatible-endpoint',
    };
  }
  if (needsOperatorConfig(entry.openai_base_url)) {
    return {
      descriptor: null,
      intelligence,
      unroutableReason: 'base-url-needs-operator-substitution',
    };
  }

  const descriptor: ProviderDescriptor = {
    id: entry.slug,
    name: entry.name,
    kinds: kindsForModalities(modalities),
    // The one adapter this dataset can honestly back: it publishes an
    // OpenAI-compatible base URL and nothing about any native protocol.
    adapter: 'openai-compatible',
    baseUrl: entry.openai_base_url,
    auth: entry.env_key ? 'api-key' : 'none',
    envKeys: entry.env_key ? [entry.env_key] : [],
    // Imported, not vetted here. Trust is something the operator grants.
    trust: 'unknown',
    docsUrl: entry.docs_url || null,
    local: false,
    // OpenAI-compatible implies GET /models, but it is not guaranteed to work;
    // discovery failing is handled and reported rather than assumed away.
    supportsDiscovery: true,
    dataUse: {
      trainingUse: 'unknown',
      commercialUse:
        entry.commercial_ok === true ? 'allowed' : entry.commercial_ok === false ? 'not_allowed' : 'unknown',
      retention: null,
      privacyNote: entry.notes ?? null,
      policyUrl: entry.docs_url || null,
    },
    defaultPricing: pricingForAccess(freeAccess, entry.rate_limits ?? entry.free_tier ?? null),
    notes: [entry.free_tier, entry.best_for].filter(Boolean).join(' — ') || undefined,
  };

  return { descriptor, intelligence, unroutableReason: null };
}

export interface NormalizedDataset {
  version: string;
  generated: string;
  providers: NormalizedProvider[];
  /** Entries that produced a callable descriptor. */
  routable: number;
  /** Entries that enrich a provider Meridian already ships. */
  enrichedExisting: number;
  /** Entries with no callable endpoint, by reason. */
  unroutable: Record<string, number>;
}

export function normalizeDataset(
  dataset: FreeLlmHubDataset,
  opts: { now: number; existingIds: ReadonlySet<string> },
): NormalizedDataset {
  const providers = dataset.providers.map((e) => normalizeEntry(e, dataset, opts));
  const unroutable: Record<string, number> = {};
  let routable = 0;
  let enrichedExisting = 0;
  for (const p of providers) {
    if (p.descriptor) routable += 1;
    else if (p.unroutableReason === 'already-shipped') enrichedExisting += 1;
    if (p.unroutableReason && p.unroutableReason !== 'already-shipped') {
      unroutable[p.unroutableReason] = (unroutable[p.unroutableReason] ?? 0) + 1;
    }
  }
  return {
    version: dataset.version,
    generated: dataset.generated,
    providers,
    routable,
    enrichedExisting,
    unroutable,
  };
}

/** Parse and validate a raw payload. Throws with a readable message. */
export function parseDataset(raw: unknown): FreeLlmHubDataset {
  const result = freeLlmHubDatasetSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `free-llm-api-hub dataset failed validation: ${first?.path.join('.') || '(root)'}: ${first?.message}`,
    );
  }
  return result.data;
}
