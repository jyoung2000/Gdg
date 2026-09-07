/**
 * Price book, sourced from LiteLLM's model metadata.
 *
 * Upstream: https://github.com/BerriAI/litellm (MIT outside `enterprise/`;
 * this file lives at the repository root and is therefore MIT).
 *
 * This exists to close a hole that made every cost number in Meridian a
 * fiction. The shipped catalog carries a pricing *posture* — METERED, FREE_DAILY
 * — and no rates, and only OpenRouter publishes real per-model prices in its
 * listing. For every other paid provider `computeCost` therefore returned zero,
 * so usage reported $0 on calls that cost real money, budget caps could not
 * bind on spend that always computed to zero, and "cheapest route" could not
 * compare what it could not see.
 *
 * LiteLLM maintains ~3,850 entries across ~130 providers with per-token input
 * and output rates, cached-input rates, context windows and capability flags.
 * Meridian syncs it as a price book rather than a model list: it does not
 * create models or providers, it fills in rates for models discovery already
 * found.
 *
 * Matching is deliberately strict. A rate is only applied when the entry is
 * confidently about the same model AT THE SAME PROVIDER, because the identical
 * weights cost different amounts through different hosts and quietly borrowing
 * one host's rate for another is exactly the kind of confident wrong number
 * this subsystem exists to avoid.
 */
import { z } from 'zod';
import type { Pricing, Provenance } from '@meridian/shared';
import { normalizeModelKey } from '../routes.js';
import type { ConfidenceLevel, SourceModelFacts } from './types.js';

export const LITELLM_SOURCE_ID = 'litellm-price-book';
export const LITELLM_REPO = 'https://github.com/BerriAI/litellm';
export const LITELLM_LICENSE = 'MIT';
export const DEFAULT_PRICE_BOOK_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/* ------------------------------------------------------------------ */
/* Upstream shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * One entry. Everything is optional because the file is heterogeneous — image
 * models price per image, audio per second, and a few entries carry only a
 * context window.
 */
const entrySchema = z
  .object({
    litellm_provider: z.string().optional(),
    mode: z.string().optional(),
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    input_cost_per_image: z.number().optional(),
    output_cost_per_image: z.number().optional(),
    input_cost_per_second: z.number().optional(),
    max_tokens: z.number().optional(),
    max_input_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
    supports_vision: z.boolean().optional(),
    supports_function_calling: z.boolean().optional(),
    supports_tool_choice: z.boolean().optional(),
    supports_response_schema: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_prompt_caching: z.boolean().optional(),
  })
  .passthrough();

export type PriceBookEntry = z.infer<typeof entrySchema>;

/** The file is a flat object of model-key → entry, plus a metadata key. */
export const priceBookSchema = z.record(z.union([entrySchema, z.string()]));

/* ------------------------------------------------------------------ */
/* Provider alias map                                                  */
/* ------------------------------------------------------------------ */

/**
 * Meridian provider id → the names LiteLLM uses for the same provider.
 *
 * Hand-written and conservative: an unlisted provider simply gets no prices,
 * which leaves its cost unknown. That is the safe direction — an unknown rate
 * renders as "—" and is excluded from cheapest comparisons, whereas a wrong
 * mapping would attach one company's rate card to another's bill.
 */
export const PROVIDER_ALIASES: Record<string, string[]> = {
  openai: ['openai', 'text-completion-openai'],
  anthropic: ['anthropic'],
  google: ['gemini', 'vertex_ai-language-models', 'vertex_ai'],
  'google-gemini': ['gemini'],
  mistral: ['mistral'],
  deepseek: ['deepseek'],
  groq: ['groq'],
  cerebras: ['cerebras'],
  together: ['together_ai'],
  fireworks: ['fireworks_ai'],
  'fireworks-ai': ['fireworks_ai'],
  // OpenRouter is deliberately ABSENT. It publishes real per-model rates in
  // its own listing, and the adapter reads them during discovery; mapping it
  // here would let a third-party book shadow the provider's own numbers, which
  // is backwards. Absence from this map is how a provider says "ask me".
  xai: ['xai'],
  cohere: ['cohere', 'cohere_chat'],
  nvidia: ['nvidia_nim'],
  'nvidia-nim': ['nvidia_nim'],
  sambanova: ['sambanova'],
  cloudflare: ['cloudflare'],
  'cloudflare-workers-ai': ['cloudflare'],
  huggingface: ['huggingface'],
  replicate: ['replicate'],
  ai21: ['ai21'],
  novita: ['novita'],
  nebius: ['nebius'],
  volcengine: ['volcengine'],
  perplexity: ['perplexity'],
  anyscale: ['anyscale'],
  voyage: ['voyage'],
  jina: ['jina_ai'],
  'jina-ai': ['jina_ai'],
};

/* ------------------------------------------------------------------ */
/* The price book                                                      */
/* ------------------------------------------------------------------ */

export interface PriceFacts {
  pricing: Pricing;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: CapabilityFlags;
  /** The upstream key this came from, so a lookup can be explained. */
  matchedKey: string;
  /** Exact id match, or a normalised match within the same provider. */
  matchKind: 'exact' | 'provider-qualified' | 'normalized';
}

const PER_MTOK = 1_000_000;

/** Convert a per-token USD rate to Meridian's per-million-token convention. */
export function perMTok(perToken: number | undefined): number | null {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken < 0) return null;
  // Rounded to a sane number of decimals: these are fractions of a cent and
  // floating point noise would otherwise show up in the UI.
  return Math.round(perToken * PER_MTOK * 1e6) / 1e6;
}

/**
 * Turn one upstream entry into Meridian pricing.
 *
 * A zero rate is a real, meaningful value here (some hosted models genuinely
 * cost nothing), so it maps to FREE rather than being treated as missing.
 */
export function toPricing(e: PriceBookEntry): Pricing | null {
  const input = perMTok(e.input_cost_per_token);
  const output = perMTok(e.output_cost_per_token);
  const perImage = e.input_cost_per_image ?? e.output_cost_per_image;
  const perRequest = typeof perImage === 'number' ? perImage : null;

  if (input === null && output === null && perRequest === null) return null;

  const everythingFree =
    (input === null || input === 0) && (output === null || output === 0) && (perRequest ?? 0) === 0;

  return {
    kind: everythingFree ? 'FREE' : 'METERED',
    inputPerMTok: input,
    outputPerMTok: output,
    perRequest,
    note: null,
  };
}

type CapabilityFlags = NonNullable<SourceModelFacts['capabilities']>;

function capabilitiesOf(e: PriceBookEntry): CapabilityFlags {
  const caps: CapabilityFlags = {};
  if (e.supports_vision !== undefined) caps.vision = e.supports_vision;
  if (e.supports_function_calling !== undefined || e.supports_tool_choice !== undefined) {
    caps.tools = Boolean(e.supports_function_calling ?? e.supports_tool_choice);
  }
  if (e.supports_response_schema !== undefined) caps.structuredOutput = e.supports_response_schema;
  if (e.supports_reasoning !== undefined) caps.reasoning = e.supports_reasoning;
  if (e.supports_prompt_caching !== undefined) caps.promptCaching = e.supports_prompt_caching;
  if (e.mode === 'embedding') caps.embedding = true;
  if (e.mode === 'image_generation') caps.imageGeneration = true;
  if (e.mode === 'audio_transcription' || e.mode === 'audio_speech') caps.audio = true;
  return caps;
}

/**
 * An indexed price book.
 *
 * Built once per sync and queried per model, so the indexes matter: a linear
 * scan of 3,850 entries for every model in a discovery pass is the difference
 * between a fast boot and a visibly slow one.
 */
export class PriceBook {
  /** Upstream key, verbatim. */
  private readonly byKey = new Map<string, PriceBookEntry>();
  /** `${litellm_provider}::${normalizedModelKey}`. */
  private readonly byProviderAndKey = new Map<string, { key: string; entry: PriceBookEntry }>();

  readonly size: number;

  constructor(raw: Record<string, unknown>) {
    for (const [key, value] of Object.entries(raw)) {
      // The file carries a `sample_spec` documentation pseudo-entry and a
      // string-valued metadata key; neither is a model.
      if (!value || typeof value !== 'object' || key === 'sample_spec') continue;
      const parsed = entrySchema.safeParse(value);
      if (!parsed.success) continue;
      const entry = parsed.data;
      this.byKey.set(key.toLowerCase(), entry);

      if (entry.litellm_provider) {
        // Strip any provider prefix from the key before normalising, so
        // "groq/llama-3.3-70b" and "llama-3.3-70b" index the same way.
        const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
        const idx = `${entry.litellm_provider.toLowerCase()}::${normalizeModelKey(tail)}`;
        if (!this.byProviderAndKey.has(idx)) this.byProviderAndKey.set(idx, { key, entry });
      }
    }
    this.size = this.byKey.size;
  }

  /**
   * Look up rates for one model.
   *
   * Tried in descending order of certainty, and it stops rather than guessing:
   * a model whose provider is not in the alias map, or whose id does not match
   * an entry for that provider, returns null and keeps an unknown price.
   */
  lookup(providerId: string, providerModelId: string): PriceFacts | null {
    const aliases = PROVIDER_ALIASES[providerId] ?? [];

    // 1. The exact upstream key, e.g. "gpt-4o" or "groq/llama-3.3-70b".
    const exact = this.byKey.get(providerModelId.toLowerCase());
    if (exact && this.providerMatches(exact, aliases)) {
      return this.facts(exact, providerModelId, 'exact');
    }

    // 2. Provider-qualified, e.g. Meridian's "llama-3.3-70b" on groq against
    //    upstream's "groq/llama-3.3-70b".
    for (const alias of aliases) {
      const qualified = this.byKey.get(`${alias}/${providerModelId}`.toLowerCase());
      if (qualified) return this.facts(qualified, `${alias}/${providerModelId}`, 'provider-qualified');
    }

    // 3. Normalised, but ONLY within the same provider. Never across providers:
    //    the same weights cost different amounts through different hosts.
    const norm = normalizeModelKey(providerModelId);
    for (const alias of aliases) {
      const hit = this.byProviderAndKey.get(`${alias.toLowerCase()}::${norm}`);
      if (hit) return this.facts(hit.entry, hit.key, 'normalized');
    }

    return null;
  }

  private providerMatches(e: PriceBookEntry, aliases: string[]): boolean {
    // With no alias mapping we cannot confirm the entry is about this
    // provider, so an exact key match alone is not enough.
    if (aliases.length === 0) return false;
    return e.litellm_provider ? aliases.includes(e.litellm_provider) : false;
  }

  private facts(e: PriceBookEntry, matchedKey: string, matchKind: PriceFacts['matchKind']): PriceFacts | null {
    const pricing = toPricing(e);
    const contextLength = e.max_input_tokens ?? e.max_tokens ?? null;
    const maxOutputTokens = e.max_output_tokens ?? null;
    const capabilities = capabilitiesOf(e);
    // An entry with no rates, no window and no flags teaches nothing.
    if (!pricing && contextLength === null && maxOutputTokens === null && Object.keys(capabilities).length === 0) {
      return null;
    }
    return {
      pricing: pricing ?? { kind: 'UNKNOWN', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null },
      contextLength,
      maxOutputTokens,
      capabilities,
      matchedKey,
      matchKind,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

export function priceProvenance(now: number, matchKind: PriceFacts['matchKind']): Provenance {
  return {
    source: LITELLM_SOURCE_ID,
    sourceType: 'dataset',
    sourceUrl: LITELLM_REPO,
    sourceVersion: null,
    sourceVerified: false,
    verificationMethod:
      matchKind === 'exact'
        ? 'Matched the upstream price book on the exact model id for this provider.'
        : matchKind === 'provider-qualified'
          ? 'Matched a provider-qualified key in the upstream price book.'
          : 'Matched a normalised model id within the same provider in the upstream price book.',
    lastVerified: null,
    // A community-maintained rate card is good evidence and is not an invoice.
    // Published rates also change without notice, so this never reads as high.
    confidence: matchKind === 'exact' ? 'medium' : 'low',
    importedAt: now,
  };
}

export function priceConfidence(matchKind: PriceFacts['matchKind']): ConfidenceLevel {
  return matchKind === 'normalized' ? 'UNVERIFIED' : 'LIKELY';
}
