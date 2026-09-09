/**
 * The dataset sources, as actual plugins.
 *
 * `DiscoverySource` was declared, documented and tested — and never
 * implemented. The parsing and normalisation for three datasets existed as
 * loose functions that nothing called; the precedence table and the confidence
 * arithmetic were exercised only by unit tests of themselves. This file is the
 * part that was missing: each dataset wrapped as a source that can be loaded,
 * merged and reported on.
 *
 * Every source here is a *document*, not a provider. That matters for what they
 * are allowed to claim. A document says what someone believed on the day they
 * wrote it, so nothing in this file may produce a `VERIFIED` claim, and every
 * claim carries the date its author last checked it. Only a live call to the
 * provider can verify anything, and that lives elsewhere.
 */
import { z } from 'zod';
import type { Pricing, Provenance, ProviderDescriptor, ProviderIntelligence } from '@meridian/shared';

/**
 * A quota with no rate attached.
 *
 * These sources publish "15 requests a minute" and say nothing about what a
 * token costs. `kind: 'UNKNOWN'` with null rates is the truthful reading: the
 * allowance is real and the price is not established. Writing `0` here — which
 * a cast would have let through — would turn "we do not know" into "it is
 * free", which is the single failure this whole subsystem exists to prevent.
 */
function quotaOnly(freeQuota: NonNullable<Pricing['freeQuota']>): Pricing {
  return { kind: 'UNKNOWN', inputPerMTok: null, outputPerMTok: null, perRequest: null, freeQuota };
}
import { fetchJsonCached } from './http.js';
import {
  DEFAULT_DATASET_URL,
  SOURCE_ID as HUB_SOURCE_ID,
  SOURCE_REPO as HUB_REPO,
  freeLlmHubDatasetSchema,
  normalizeDataset,
} from './free-llm-api-hub.js';
import {
  MNFST_METADATA,
  MNFST_URL,
  UZAIR_METADATA,
  communityProvenance,
  freeQuotaOf,
  mnfstSchema,
  namedModels,
  parseRateLimitText,
  parseTokenCount,
  slugify,
  uzairConfidence,
  uzairIntelligence,
  uzairProviderSchema,
  type MnfstProvider,
  type UzairProvider,
} from './community-registries.js';
import {
  ageAdjusted,
  emptySnapshot,
  type ConfidenceLevel,
  type DiscoveryContext,
  type DiscoverySource,
  type SourceMetadata,
  type SourceModelFacts,
  type SourceProvider,
  type SourceSnapshot,
} from './types.js';

/* ------------------------------------------------------------------ */
/* free-llm-api-hub                                                    */
/* ------------------------------------------------------------------ */

export const HUB_METADATA: SourceMetadata = {
  id: HUB_SOURCE_ID,
  displayName: 'free-llm-api-hub',
  url: HUB_REPO,
  license: 'MIT',
  attribution: 'Provider catalogue from github.com/pacocartones/free-llm-api-hub (MIT).',
  sourceClass: 'verified-dataset',
  // Entries carry `verified` and `last_verified`, so a dated one can reach
  // LIKELY. It can never reach VERIFIED: that word is reserved for something
  // Meridian checked against the provider itself.
  baseConfidence: 'LIKELY',
  contributes: ['providers', 'models', 'access-terms', 'pricing', 'quota'],
};

export class FreeLlmHubSource implements DiscoverySource {
  readonly metadata = HUB_METADATA;

  constructor(private readonly url: string = DEFAULT_DATASET_URL) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const result = await fetchJsonCached({
      url: this.url,
      cacheDir: ctx.cacheDir,
      cacheKey: HUB_SOURCE_ID,
      now: ctx.now,
      timeoutMs: ctx.timeoutMs,
      offline: ctx.offline,
      fetchImpl: ctx.fetchImpl,
      validate: (raw): raw is z.infer<typeof freeLlmHubDatasetSchema> => freeLlmHubDatasetSchema.safeParse(raw).success,
      describeInvalid: (raw) => {
        const issue = freeLlmHubDatasetSchema.safeParse(raw);
        return issue.success ? 'unknown' : `${issue.error.issues[0]?.path.join('.') || '(root)'}: ${issue.error.issues[0]?.message}`;
      },
    });

    if (!result.payload) return emptySnapshot(this.metadata, ctx.now, result.error ?? 'No payload.');

    const normalized = normalizeDataset(result.payload, {
      now: ctx.now,
      existingIds: ctx.existingIds ?? new Set(),
    });

    const providers: SourceProvider[] = normalized.providers.map((p) => ({
      providerId: p.intelligence.providerId,
      descriptor: p.descriptor,
      intelligence: p.intelligence,
      unroutableReason: p.unroutableReason,
    }));

    // The dataset names free models but publishes no per-model facts beyond
    // that, so each named model becomes an existence claim and nothing more.
    // Inventing a context length here would be worse than leaving it unknown.
    const models: SourceModelFacts[] = [];
    for (const p of normalized.providers) {
      for (const id of p.intelligence.freeModelIds) {
        models.push({
          modelId: `${p.intelligence.providerId}:${id}`,
          providerId: p.intelligence.providerId,
          providerModelId: id,
          pricing: p.descriptor?.defaultPricing,
          provenance: p.intelligence.provenance,
          confidence: ageAdjusted(this.metadata.baseConfidence, p.intelligence.provenance.lastVerified, ctx.now),
        });
      }
    }

    return {
      metadata: this.metadata,
      version: normalized.version,
      generated: normalized.generated,
      fetchedAt: result.fetchedAt ?? ctx.now,
      fromCache: result.fromCache,
      cacheAgeDays: result.cacheAgeDays,
      providers,
      models,
      error: result.error,
    };
  }
}

/* ------------------------------------------------------------------ */
/* mnfst/awesome-free-llm-apis                                         */
/* ------------------------------------------------------------------ */

/**
 * Model listings, and nothing that would let Meridian call them.
 *
 * This dataset names providers and their models with human-written rate-limit
 * text, but publishes no base URL for most and no auth details for any. So it
 * contributes model existence and parsed limits, and every entry is explicitly
 * unroutable — which is a useful contribution, not a failed one: knowing that a
 * model exists on a free tier is what lets the UI tell an operator where to go
 * and sign up.
 */
export class MnfstSource implements DiscoverySource {
  readonly metadata = MNFST_METADATA;

  constructor(private readonly url: string = MNFST_URL) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const result = await fetchJsonCached({
      url: this.url,
      cacheDir: ctx.cacheDir,
      cacheKey: this.metadata.id,
      now: ctx.now,
      timeoutMs: ctx.timeoutMs,
      offline: ctx.offline,
      fetchImpl: ctx.fetchImpl,
      validate: (raw): raw is z.infer<typeof mnfstSchema> => mnfstSchema.safeParse(raw).success,
      describeInvalid: () => 'not the provider list this source publishes',
    });

    if (!result.payload) return emptySnapshot(this.metadata, ctx.now, result.error ?? 'No payload.');

    const dataset = result.payload;
    const lastUpdated = dataset.lastUpdated ?? null;
    const confidence = ageAdjusted(this.metadata.baseConfidence, lastUpdated, ctx.now);
    const providers: SourceProvider[] = [];
    const models: SourceModelFacts[] = [];

    for (const entry of dataset.providers) {
      const providerId = slugify(entry.name);
      const provenance = communityProvenance(this.metadata.id, entry.url ?? this.metadata.url, lastUpdated, ctx.now);
      providers.push({
        providerId,
        // No auth model and, for most entries, no base URL. A descriptor built
        // from this would be a route that fails on its first call.
        descriptor: null,
        intelligence: mnfstIntelligence(entry, providerId, provenance),
        unroutableReason: 'source-publishes-no-callable-endpoint',
      });

      for (const model of namedModels(entry)) {
        const quota = parseRateLimitText(model.rateLimit);
        models.push({
          modelId: `${providerId}:${model.id}`,
          providerId,
          providerModelId: model.id,
          contextLength: parseTokenCount(model.context),
          maxOutputTokens: parseTokenCount(model.maxOutput),
          pricing: quota && Object.keys(quota).length ? quotaOnly(quota) : undefined,
          provenance,
          confidence,
        });
      }
    }

    return {
      metadata: this.metadata,
      version: lastUpdated,
      generated: lastUpdated,
      fetchedAt: result.fetchedAt ?? ctx.now,
      fromCache: result.fromCache,
      cacheAgeDays: result.cacheAgeDays,
      providers,
      models,
      error: result.error,
    };
  }
}

function mnfstIntelligence(entry: MnfstProvider, providerId: string, provenance: Provenance): ProviderIntelligence {
  return {
    providerId,
    // The list is called "free LLM APIs", which is a claim about the list, not
    // about any entry in it. Nothing here says which *kind* of free an entry
    // is — perpetual tier, trial credit, or a promotion that ended last month —
    // so it stays UNKNOWN. Rendering it as free because of the repository's
    // name is exactly the mistake this codebase refuses to make.
    freeAccess: 'UNKNOWN',
    freeTierSummary: null,
    rateLimitSummary: namedModels(entry).find((m) => m.rateLimit)?.rateLimit ?? null,
    caveat: entry.description ?? null,
    bestFor: null,
    expires: null,
    requirements: { apiKey: 'unknown', account: 'unknown', card: 'unknown', phone: 'unknown' },
    commercialUse: 'unknown',
    openAiCompatible: entry.baseUrl ? 'unknown' : 'unknown',
    openAiBaseUrl: entry.baseUrl ?? null,
    freeModelIds: namedModels(entry).map((m) => m.id),
    modalities: [...new Set(namedModels(entry).map((m) => m.modality).filter((m): m is string => !!m))],
    provenance,
  };
}

/* ------------------------------------------------------------------ */
/* uzair004/awesome-free-llm-apis                                      */
/* ------------------------------------------------------------------ */

/**
 * One file, not eight API calls.
 *
 * The constant this replaces pointed at `api.github.com/.../contents/providers`
 * — the directory listing — which would have needed one unauthenticated API
 * call per provider against a 60-per-hour budget shared with everything else
 * on the host. The repository publishes `registry.json`: every provider, one
 * request, no API, no token, no rate limit.
 */
export const UZAIR_REGISTRY_URL =
  'https://raw.githubusercontent.com/uzair004/awesome-free-llm-apis/main/registry.json';

const uzairRegistrySchema = z.object({
  version: z.string().optional(),
  generatedAt: z.string().optional(),
  providerCount: z.number().optional(),
  providers: z.record(uzairProviderSchema),
});

export class UzairSource implements DiscoverySource {
  readonly metadata = UZAIR_METADATA;

  constructor(private readonly url: string = UZAIR_REGISTRY_URL) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const result = await fetchJsonCached({
      url: this.url,
      cacheDir: ctx.cacheDir,
      cacheKey: this.metadata.id,
      now: ctx.now,
      timeoutMs: ctx.timeoutMs,
      offline: ctx.offline,
      fetchImpl: ctx.fetchImpl,
      validate: (raw): raw is z.infer<typeof uzairRegistrySchema> => uzairRegistrySchema.safeParse(raw).success,
      describeInvalid: () => 'not the provider registry this source publishes',
    });

    if (!result.payload) return emptySnapshot(this.metadata, ctx.now, result.error ?? 'No payload.');

    const registry = result.payload;
    const providers: SourceProvider[] = [];
    const models: SourceModelFacts[] = [];

    for (const entry of Object.values(registry.providers)) {
      const intelligence = uzairIntelligence(entry, ctx.now);
      const confidence = ageAdjusted(uzairConfidence(entry), entry.lastVerified ?? null, ctx.now);

      providers.push({
        providerId: entry.id,
        // Deliberately no descriptor. This source publishes an env var name and
        // an auth header, which is most of what a route needs — and not the
        // base URL, which is the rest of it. Half a route is not a route.
        descriptor: null,
        intelligence,
        unroutableReason:
          entry.status && entry.status !== 'active'
            ? `source-reports-status-${entry.status}`
            : 'source-publishes-no-base-url',
      });

      const quota = freeQuotaOf(entry);
      for (const model of entry.models ?? []) {
        // `free: false` is a real claim, and it is the claim that stops a
        // "free only" filter from picking up a paid model on a free provider.
        const isFree = model.free !== false;
        models.push({
          modelId: `${entry.id}:${model.id}`,
          providerId: entry.id,
          providerModelId: model.id,
          contextLength: model.contextWindow ?? null,
          maxOutputTokens: model.maxOutputTokens ?? null,
          pricing: isFree && quota ? quotaOnly(quota) : undefined,
          capabilities: capabilitiesFrom(model.capabilities),
          provenance: intelligence.provenance,
          confidence,
        });
      }
    }

    return {
      metadata: this.metadata,
      version: registry.version ?? null,
      generated: registry.generatedAt ? registry.generatedAt.slice(0, 10) : null,
      fetchedAt: result.fetchedAt ?? ctx.now,
      fromCache: result.fromCache,
      cacheAgeDays: result.cacheAgeDays,
      providers,
      models,
      error: result.error,
    };
  }
}

/**
 * Capability names as this source spells them.
 *
 * Absent is not false. A source that lists `tools` and says nothing about
 * vision has not said the model lacks vision, so unmentioned capabilities are
 * left undefined and stay unknown rather than becoming a negative claim that
 * would exclude the model from a search it should have matched.
 */
function capabilitiesFrom(names: string[] | undefined): SourceModelFacts['capabilities'] {
  if (!names || names.length === 0) return undefined;
  const set = new Set(names.map((n) => n.toLowerCase()));
  const caps: NonNullable<SourceModelFacts['capabilities']> = {};
  if (set.has('tools') || set.has('function_calling') || set.has('functions')) caps.tools = true;
  if (set.has('structuredoutput') || set.has('structured_output') || set.has('json_mode')) caps.structuredOutput = true;
  if (set.has('reasoning') || set.has('thinking')) caps.reasoning = true;
  if (set.has('vision') || set.has('image_input') || set.has('multimodal')) caps.vision = true;
  if (set.has('promptcaching') || set.has('prompt_caching') || set.has('caching')) caps.promptCaching = true;
  if (set.has('embedding') || set.has('embeddings')) caps.embedding = true;
  if (set.has('audio') || set.has('speech')) caps.audio = true;
  if (set.has('imagegeneration') || set.has('image_generation')) caps.imageGeneration = true;
  return Object.keys(caps).length ? caps : undefined;
}

/* ------------------------------------------------------------------ */

export function datasetSources(): DiscoverySource[] {
  return [new FreeLlmHubSource(), new UzairSource(), new MnfstSource()];
}

export type { ConfidenceLevel, ProviderDescriptor };
