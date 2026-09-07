/**
 * Discovery sources: where Meridian's knowledge of the world comes from.
 *
 * No single source knows everything. A curated dataset knows a provider's
 * signup terms but not its per-token rate; a price book knows the rate but
 * nothing about whether a card is required; only the provider's own API knows
 * which models exist right now. So sources are plugins, each declaring what it
 * is authoritative about, and the registry merges them under an explicit
 * precedence rather than letting whichever loaded last win.
 *
 * Two rules keep merging from turning into fiction.
 *
 * A source may only contribute what it actually observed. A source that
 * publishes rates does not thereby get an opinion on commercial-use terms, and
 * `contributes` is how it says so.
 *
 * A claim carries its origin forever. Every merged field remembers which source
 * supplied it and how confident that source was, so the UI can say "this rate
 * came from a community price book last updated in August" rather than implying
 * Meridian confirmed it against an invoice.
 */
import type { Pricing, Provenance, ProviderDescriptor, ProviderIntelligence } from '@meridian/shared';

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

/**
 * How much weight a claim deserves.
 *
 * Ordered deliberately: this is the tie-breaker when two sources disagree, so
 * it has to be comparable rather than decorative.
 */
export const CONFIDENCE_LEVELS = [
  /** Meridian checked it against the provider itself, here, recently. */
  'VERIFIED',
  /** A source that independently confirms its entries and dates them. */
  'LIKELY',
  /** Was confirmed once, but long enough ago that it may have moved. */
  'STALE',
  /** Recorded by someone, with no evidence of checking. */
  'UNVERIFIED',
  /** Known not to work right now. */
  'UNAVAILABLE',
] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Higher wins when two sources disagree. */
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  VERIFIED: 4,
  LIKELY: 3,
  STALE: 2,
  UNVERIFIED: 1,
  UNAVAILABLE: 0,
};

export function strongerConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

export function confidenceRank(c: ConfidenceLevel): number {
  return CONFIDENCE_RANK[c];
}

/**
 * Age past which a dated claim stops being LIKELY and becomes STALE.
 *
 * Free tiers are withdrawn and rates change with no notice, so a claim nobody
 * has rechecked in three months is not evidence of what is true today.
 */
export const STALE_AFTER_DAYS = 90;

/** Downgrade a source's own confidence for how old the claim is. */
export function ageAdjusted(
  base: ConfidenceLevel,
  lastVerified: string | null,
  now: number,
): ConfidenceLevel {
  if (base === 'UNAVAILABLE' || base === 'UNVERIFIED') return base;
  if (!lastVerified) return 'UNVERIFIED';
  const t = Date.parse(lastVerified);
  if (Number.isNaN(t)) return 'UNVERIFIED';
  const days = Math.floor((now - t) / 86_400_000);
  return days > STALE_AFTER_DAYS ? 'STALE' : base;
}

/* ------------------------------------------------------------------ */
/* Source precedence                                                   */
/* ------------------------------------------------------------------ */

/**
 * Which source wins when two disagree, before confidence is considered.
 *
 * The order is the spec's, and the reasoning behind it is that proximity to the
 * provider beats popularity. A provider's own API describing its own models
 * outranks any third party's description of them, however well maintained; a
 * live check outranks a document; and an operator's explicit configuration
 * outranks everything, because they can see things Meridian cannot.
 */
export const SOURCE_PRECEDENCE = [
  'user-configured',
  'live-check',
  'provider-native',
  'verified-dataset',
  'community-catalog',
  'static-list',
] as const;
export type SourceClass = (typeof SOURCE_PRECEDENCE)[number];

export function sourceRank(c: SourceClass): number {
  // Earlier in the list wins, so invert the index into a score.
  const i = SOURCE_PRECEDENCE.indexOf(c);
  return i < 0 ? 0 : SOURCE_PRECEDENCE.length - i;
}

/* ------------------------------------------------------------------ */
/* What a source can contribute                                        */
/* ------------------------------------------------------------------ */

export const CONTRIBUTIONS = [
  /** Which providers exist and how to reach them. */
  'providers',
  /** Which models exist. */
  'models',
  /** Per-token or per-request rates. */
  'pricing',
  /** Context window and max output. */
  'limits',
  /** Vision, tools, structured output and the rest. */
  'capabilities',
  /** Free-tier shape, quotas, card/phone requirements, commercial use. */
  'access-terms',
  /** Published rate limits and how to read remaining quota. */
  'quota',
] as const;
export type Contribution = (typeof CONTRIBUTIONS)[number];

/* ------------------------------------------------------------------ */
/* The interface                                                       */
/* ------------------------------------------------------------------ */

export interface SourceMetadata {
  id: string;
  displayName: string;
  /** Where a human can go and read it. */
  url: string;
  license: string;
  /** Attribution text surfaced in the product and in the notices file. */
  attribution: string;
  sourceClass: SourceClass;
  /** The best confidence any claim from this source can have. */
  baseConfidence: ConfidenceLevel;
  /** What this source is entitled to have an opinion about. */
  contributes: Contribution[];
}

/** One provider as a source describes it, with its own provenance attached. */
export interface SourceProvider {
  /** Meridian's provider id this entry is about. */
  providerId: string;
  /** Present when the source knows enough to make a callable route. */
  descriptor: ProviderDescriptor | null;
  /** Access and economics, when the source speaks to them. */
  intelligence: ProviderIntelligence | null;
  /** Why no descriptor, when there is none. */
  unroutableReason: string | null;
}

/** Model facts a source can supply, keyed by Meridian's `provider:model` id. */
export interface SourceModelFacts {
  modelId: string;
  providerId: string;
  providerModelId: string;
  pricing?: Pricing;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  /** Capability flags the source asserts. Absent means "did not say". */
  capabilities?: {
    vision?: boolean;
    tools?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    promptCaching?: boolean;
    embedding?: boolean;
    imageGeneration?: boolean;
    audio?: boolean;
  };
  provenance: Provenance;
  confidence: ConfidenceLevel;
}

export interface SourceSnapshot {
  metadata: SourceMetadata;
  /** Version the source publishes, when it publishes one. */
  version: string | null;
  /** Date the payload was produced upstream (YYYY-MM-DD), when known. */
  generated: string | null;
  /** When Meridian fetched it (epoch ms). */
  fetchedAt: number;
  fromCache: boolean;
  /** Whole days since the served payload was fetched. */
  cacheAgeDays: number | null;
  providers: SourceProvider[];
  models: SourceModelFacts[];
  error: string | null;
}

export interface DiscoveryContext {
  cacheDir: string;
  now: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Read only what is cached; never touch the network. */
  offline?: boolean;
  /** Providers Meridian already ships, so imports enrich rather than replace. */
  existingIds?: ReadonlySet<string>;
}

/**
 * A pluggable source of model and provider knowledge.
 *
 * `load` never throws: an unreachable source is a reportable state, not an
 * exception that takes down a gateway boot.
 */
export interface DiscoverySource {
  readonly metadata: SourceMetadata;
  load(ctx: DiscoveryContext): Promise<SourceSnapshot>;
}

/** An empty snapshot, for a source that could not load. */
export function emptySnapshot(
  metadata: SourceMetadata,
  now: number,
  error: string,
): SourceSnapshot {
  return {
    metadata,
    version: null,
    generated: null,
    fetchedAt: now,
    fromCache: false,
    cacheAgeDays: null,
    providers: [],
    models: [],
    error,
  };
}
