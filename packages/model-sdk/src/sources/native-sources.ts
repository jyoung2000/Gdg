/**
 * Sources that ask a provider about its own models.
 *
 * A dataset says what someone believed in August. These endpoints say what the
 * provider is serving right now, which is why they sit above every dataset in
 * `SOURCE_PRECEDENCE`. All three are public: no key, no account, no signup.
 * That is the whole reason they are here — a person who has configured nothing
 * should still be able to see what free inference exists.
 *
 * ── On verification, honestly ──
 *
 * The parsers below are written against each provider's published response
 * shape. They have **not** been observed against the live endpoints from the
 * machine that wrote them: this build environment reaches
 * `raw.githubusercontent.com` and almost nothing else, so `openrouter.ai`,
 * `huggingface.co` and `pollinations.ai` all fail at CONNECT here. What is
 * proved is the parsing, against captured response fixtures, and the failure
 * behaviour when a response is not what was expected.
 *
 * So every parser is written to degrade rather than throw. Fields are optional,
 * unknown keys pass through, and a row that cannot be understood is skipped
 * rather than taking the rest of the catalogue with it. If a provider changes
 * its response, the visible result should be "this source returned fewer models
 * than usual", not a boot failure — and `docs/DISCOVERY.md` records which of
 * these has ever been seen working against the real endpoint.
 */
import { z } from 'zod';
import type { Pricing, Provenance } from '@meridian/shared';
import { fetchJsonCached } from './http.js';
import {
  emptySnapshot,
  type DiscoveryContext,
  type DiscoverySource,
  type SourceMetadata,
  type SourceModelFacts,
  type SourceProvider,
  type SourceSnapshot,
} from './types.js';

/** A provider answering about itself, now. As direct as evidence gets short of a call. */
function nativeProvenance(sourceId: string, url: string, now: number): Provenance {
  return {
    source: sourceId,
    sourceType: 'provider-native',
    sourceUrl: url,
    sourceVersion: null,
    sourceVerified: true,
    verificationMethod: 'Read from the provider’s own public model listing at the time shown.',
    lastVerified: new Date(now).toISOString().slice(0, 10),
    confidence: 'high',
    importedAt: now,
  };
}

const FREE = (freeQuota?: Pricing['freeQuota'], note?: string): Pricing => ({
  kind: 'FREE',
  inputPerMTok: 0,
  outputPerMTok: 0,
  perRequest: 0,
  ...(freeQuota ? { freeQuota } : {}),
  ...(note ? { note } : {}),
});

/** No readable rate. Never zero: a budget policy that saw zero here would authorise spending it cannot predict. */
const UNKNOWN_RATE = (note: string): Pricing => ({
  kind: 'UNKNOWN',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note,
});

/* ------------------------------------------------------------------ */
/* OpenRouter                                                          */
/* ------------------------------------------------------------------ */

export const OPENROUTER_SOURCE_ID = 'openrouter-native';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const OPENROUTER_METADATA: SourceMetadata = {
  id: OPENROUTER_SOURCE_ID,
  displayName: 'OpenRouter model listing',
  url: 'https://openrouter.ai/docs/api-reference/list-available-models',
  license: 'Provider API — data used as served, not redistributed',
  attribution: 'Model list and rate card from OpenRouter’s public /api/v1/models endpoint.',
  sourceClass: 'provider-native',
  baseConfidence: 'VERIFIED',
  contributes: ['models', 'pricing', 'limits', 'capabilities'],
};

const orModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    context_length: z.number().nullable().optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
        modality: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    pricing: z.record(z.union([z.string(), z.number()])).optional(),
    top_provider: z
      .object({ context_length: z.number().nullable().optional(), max_completion_tokens: z.number().nullable().optional() })
      .partial()
      .passthrough()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

const orListSchema = z.object({ data: z.array(orModelSchema) });

/** Pricing strings are per-token decimals ("0.0000005"). Zero means zero. */
function orRate(pricing: Record<string, string | number> | undefined, key: string): number | null {
  const raw = pricing?.[key];
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function openRouterIsFree(model: z.infer<typeof orModelSchema>): boolean {
  const prompt = orRate(model.pricing, 'prompt');
  const completion = orRate(model.pricing, 'completion');
  const request = orRate(model.pricing, 'request');
  // Every priced dimension must be zero. A model that is free per token and
  // charges per request is not free, and a model whose rate card we could not
  // read is not free either — a missing rate is `null`, and null is not zero.
  return prompt === 0 && completion === 0 && (request === null || request === 0);
}

/**
 * OpenRouter's `:free` variants.
 *
 * The suffix is the provider's own naming for a variant served at no cost under
 * a shared daily cap. It is a strictly narrower set than "the rate card says
 * zero", which also catches models that are temporarily zero-rated.
 */
export function isOpenRouterFreeVariant(id: string): boolean {
  return id.endsWith(':free');
}

export class OpenRouterSource implements DiscoverySource {
  readonly metadata = OPENROUTER_METADATA;

  constructor(
    private readonly providerId = 'openrouter',
    private readonly url: string = OPENROUTER_MODELS_URL,
  ) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const result = await fetchJsonCached({
      url: this.url,
      cacheDir: ctx.cacheDir,
      cacheKey: this.metadata.id,
      now: ctx.now,
      timeoutMs: ctx.timeoutMs,
      offline: ctx.offline,
      fetchImpl: ctx.fetchImpl,
      validate: (raw): raw is z.infer<typeof orListSchema> => orListSchema.safeParse(raw).success,
      describeInvalid: () => 'not the model list OpenRouter serves at /api/v1/models',
    });

    if (!result.payload) return emptySnapshot(this.metadata, ctx.now, result.error ?? 'No payload.');

    const provenance = nativeProvenance(this.metadata.id, this.url, result.fetchedAt ?? ctx.now);
    const models: SourceModelFacts[] = [];
    const freeIds: string[] = [];

    for (const model of result.payload.data) {
      const free = openRouterIsFree(model);
      if (free) freeIds.push(model.id);
      models.push({
        modelId: `${this.providerId}:${model.id}`,
        providerId: this.providerId,
        providerModelId: model.id,
        contextLength: model.context_length ?? model.top_provider?.context_length ?? null,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
        pricing: pricingFromOpenRouter(model, free),
        capabilities: capabilitiesFromOpenRouter(model),
        provenance,
        confidence: 'VERIFIED',
      });
    }

    return {
      metadata: this.metadata,
      version: null,
      generated: provenance.lastVerified,
      fetchedAt: result.fetchedAt ?? ctx.now,
      fromCache: result.fromCache,
      cacheAgeDays: result.cacheAgeDays,
      providers: [
        {
          providerId: this.providerId,
          // OpenRouter is a provider Meridian ships, with a working adapter and
          // a hand-written descriptor. This source enriches it; replacing the
          // descriptor with one derived from a model list would be a downgrade.
          descriptor: null,
          intelligence: {
            providerId: this.providerId,
            // Which of OpenRouter's own models are free is a per-model fact and
            // is recorded per model. At the provider level the honest answer is
            // that both exist, and `freeModelIds` says which are which.
            freeAccess: freeIds.length > 0 ? 'FREE_DAILY_QUOTA' : 'PAID_ONLY',
            freeTierSummary:
              freeIds.length > 0
                ? `${freeIds.length} models served at a zero rate, under OpenRouter’s shared daily cap for free models.`
                : null,
            rateLimitSummary: null,
            caveat:
              'A zero rate card is not an unlimited one: free models share a daily request cap per account, and OpenRouter can change which models are free without notice.',
            bestFor: null,
            expires: null,
            requirements: { apiKey: 'yes', account: 'yes', card: 'unknown', phone: 'unknown' },
            commercialUse: 'unknown',
            openAiCompatible: 'yes',
            openAiBaseUrl: 'https://openrouter.ai/api/v1',
            freeModelIds: freeIds,
            modalities: [...new Set(result.payload.data.flatMap((m) => m.architecture?.output_modalities ?? []))],
            provenance,
          },
          unroutableReason: 'already-shipped',
        },
      ],
      models,
      error: result.error,
    };
  }
}

function pricingFromOpenRouter(model: z.infer<typeof orModelSchema>, free: boolean): Pricing {
  if (free) return FREE();
  const prompt = orRate(model.pricing, 'prompt');
  const completion = orRate(model.pricing, 'completion');
  if (prompt === null || completion === null) {
    return UNKNOWN_RATE('OpenRouter published no readable rate for this model.');
  }
  // OpenRouter quotes per token; Meridian holds per million.
  return {
    kind: 'METERED',
    inputPerMTok: prompt * 1_000_000,
    outputPerMTok: completion * 1_000_000,
    perRequest: orRate(model.pricing, 'request'),
  };
}

function capabilitiesFromOpenRouter(model: z.infer<typeof orModelSchema>): SourceModelFacts['capabilities'] {
  const params = new Set(model.supported_parameters ?? []);
  const inputs = new Set(model.architecture?.input_modalities ?? []);
  const outputs = new Set(model.architecture?.output_modalities ?? []);
  const caps: NonNullable<SourceModelFacts['capabilities']> = {};
  if (params.has('tools') || params.has('tool_choice')) caps.tools = true;
  if (params.has('response_format') || params.has('structured_outputs')) caps.structuredOutput = true;
  if (params.has('reasoning') || params.has('include_reasoning')) caps.reasoning = true;
  if (inputs.has('image')) caps.vision = true;
  if (inputs.has('audio')) caps.audio = true;
  if (outputs.has('image')) caps.imageGeneration = true;
  return Object.keys(caps).length ? caps : undefined;
}

/* ------------------------------------------------------------------ */
/* Pollinations                                                        */
/* ------------------------------------------------------------------ */

export const POLLINATIONS_SOURCE_ID = 'pollinations-native';
export const POLLINATIONS_TEXT_MODELS_URL = 'https://text.pollinations.ai/models';
export const POLLINATIONS_IMAGE_MODELS_URL = 'https://image.pollinations.ai/models';

export const POLLINATIONS_METADATA: SourceMetadata = {
  id: POLLINATIONS_SOURCE_ID,
  displayName: 'Pollinations model listing',
  url: 'https://pollinations.ai',
  license: 'Provider API — data used as served, not redistributed',
  attribution: 'Model list from Pollinations’ public model endpoints.',
  sourceClass: 'provider-native',
  baseConfidence: 'VERIFIED',
  contributes: ['models', 'capabilities'],
};

const pollinationsTextModelSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tools: z.boolean().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    tier: z.string().optional(),
  })
  .passthrough();

/**
 * A source that has to cope with two different answers.
 *
 * The image endpoint has served a bare array of names, and the text endpoint an
 * array of objects. Both are accepted, and anything else is reported rather
 * than guessed at.
 */
export class PollinationsSource implements DiscoverySource {
  readonly metadata = POLLINATIONS_METADATA;

  constructor(
    private readonly providerId = 'pollinations',
    private readonly textUrl: string = POLLINATIONS_TEXT_MODELS_URL,
    private readonly imageUrl: string = POLLINATIONS_IMAGE_MODELS_URL,
  ) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const [text, image] = await Promise.all([
      fetchJsonCached({
        url: this.textUrl,
        cacheDir: ctx.cacheDir,
        cacheKey: `${this.metadata.id}-text`,
        now: ctx.now,
        timeoutMs: ctx.timeoutMs,
        offline: ctx.offline,
        fetchImpl: ctx.fetchImpl,
        validate: (raw): raw is z.infer<typeof pollinationsTextModelSchema>[] =>
          z.array(pollinationsTextModelSchema).safeParse(raw).success,
        describeInvalid: () => 'not an array of model descriptions',
      }),
      fetchJsonCached({
        url: this.imageUrl,
        cacheDir: ctx.cacheDir,
        cacheKey: `${this.metadata.id}-image`,
        now: ctx.now,
        timeoutMs: ctx.timeoutMs,
        offline: ctx.offline,
        fetchImpl: ctx.fetchImpl,
        validate: (raw): raw is string[] => z.array(z.string()).safeParse(raw).success,
        describeInvalid: () => 'not an array of model names',
      }),
    ]);

    if (!text.payload && !image.payload) {
      return emptySnapshot(this.metadata, ctx.now, text.error ?? image.error ?? 'No payload.');
    }

    const provenance = nativeProvenance(this.metadata.id, this.metadata.url, ctx.now);
    const models: SourceModelFacts[] = [];

    for (const model of text.payload ?? []) {
      const caps: NonNullable<SourceModelFacts['capabilities']> = {};
      if (model.vision || model.input_modalities?.includes('image')) caps.vision = true;
      if (model.audio || model.input_modalities?.includes('audio')) caps.audio = true;
      if (model.tools) caps.tools = true;
      if (model.reasoning) caps.reasoning = true;
      if (model.output_modalities?.includes('image')) caps.imageGeneration = true;
      models.push({
        modelId: `${this.providerId}:${model.name}`,
        providerId: this.providerId,
        providerModelId: model.name,
        pricing: FREE(),
        capabilities: Object.keys(caps).length ? caps : undefined,
        provenance,
        confidence: 'VERIFIED',
      });
    }

    for (const name of image.payload ?? []) {
      models.push({
        modelId: `${this.providerId}:${name}`,
        providerId: this.providerId,
        providerModelId: name,
        pricing: FREE(),
        capabilities: { imageGeneration: true },
        provenance,
        confidence: 'VERIFIED',
      });
    }

    const providers: SourceProvider[] = [
      {
        providerId: this.providerId,
        descriptor: null,
        intelligence: {
          providerId: this.providerId,
          // A public endpoint that serves without a key. It is genuinely free
          // to call, and it is genuinely rate-limited by IP and can be
          // withdrawn at any time — both halves belong in what we record.
          freeAccess: 'ONGOING_FREE_TIER',
          freeTierSummary: 'Open endpoints, no key required.',
          rateLimitSummary: 'Rate-limited per address; the limits are not published as numbers.',
          caveat:
            'An anonymous public endpoint. There is no quota to read, no support, and no commitment that it will be there tomorrow — treat it as a convenience, not a dependency.',
          bestFor: 'Trying something without signing up for anything.',
          expires: null,
          requirements: { apiKey: 'no', account: 'no', card: 'no', phone: 'no' },
          commercialUse: 'unknown',
          openAiCompatible: 'unknown',
          openAiBaseUrl: null,
          freeModelIds: models.map((m) => m.providerModelId),
          modalities: [...(text.payload?.length ? ['text'] : []), ...(image.payload?.length ? ['image'] : [])],
          provenance,
        },
        unroutableReason: 'already-shipped',
      },
    ];

    return {
      metadata: this.metadata,
      version: null,
      generated: provenance.lastVerified,
      fetchedAt: text.fetchedAt ?? image.fetchedAt ?? ctx.now,
      fromCache: text.fromCache && image.fromCache,
      cacheAgeDays: text.cacheAgeDays,
      providers,
      models,
      // One endpoint down should not hide that the other worked, so both are
      // reported and neither is silently dropped.
      error: [text.error, image.error].filter(Boolean).join(' ') || null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Hugging Face                                                        */
/* ------------------------------------------------------------------ */

export const HUGGINGFACE_SOURCE_ID = 'huggingface-router';
export const HUGGINGFACE_MODELS_URL = 'https://router.huggingface.co/v1/models';

export const HUGGINGFACE_METADATA: SourceMetadata = {
  id: HUGGINGFACE_SOURCE_ID,
  displayName: 'Hugging Face Inference Providers',
  url: 'https://huggingface.co/docs/inference-providers',
  license: 'Provider API — data used as served, not redistributed',
  attribution: 'Model list from Hugging Face’s public router listing.',
  sourceClass: 'provider-native',
  baseConfidence: 'VERIFIED',
  contributes: ['models', 'limits', 'capabilities'],
};

const hfModelSchema = z
  .object({
    id: z.string(),
    owned_by: z.string().optional(),
    providers: z
      .array(
        z
          .object({
            provider: z.string().optional(),
            status: z.string().optional(),
            context_length: z.number().nullable().optional(),
            supports_tools: z.boolean().optional(),
            supports_structured_output: z.boolean().optional(),
            pricing: z.object({ input: z.number().optional(), output: z.number().optional() }).partial().passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const hfListSchema = z.object({ data: z.array(hfModelSchema) });

export class HuggingFaceSource implements DiscoverySource {
  readonly metadata = HUGGINGFACE_METADATA;

  constructor(
    private readonly providerId = 'huggingface',
    private readonly url: string = HUGGINGFACE_MODELS_URL,
  ) {}

  async load(ctx: DiscoveryContext): Promise<SourceSnapshot> {
    const result = await fetchJsonCached({
      url: this.url,
      cacheDir: ctx.cacheDir,
      cacheKey: this.metadata.id,
      now: ctx.now,
      timeoutMs: ctx.timeoutMs,
      offline: ctx.offline,
      fetchImpl: ctx.fetchImpl,
      validate: (raw): raw is z.infer<typeof hfListSchema> => hfListSchema.safeParse(raw).success,
      describeInvalid: () => 'not the model list the Hugging Face router serves',
    });

    if (!result.payload) return emptySnapshot(this.metadata, ctx.now, result.error ?? 'No payload.');

    const provenance = nativeProvenance(this.metadata.id, this.url, result.fetchedAt ?? ctx.now);
    const models: SourceModelFacts[] = [];

    for (const model of result.payload.data) {
      const live = (model.providers ?? []).filter((p) => !p.status || p.status === 'live');
      if (live.length === 0) continue;
      const context = live.map((p) => p.context_length).filter((n): n is number => typeof n === 'number');
      const caps: NonNullable<SourceModelFacts['capabilities']> = {};
      if (live.some((p) => p.supports_tools)) caps.tools = true;
      if (live.some((p) => p.supports_structured_output)) caps.structuredOutput = true;

      models.push({
        modelId: `${this.providerId}:${model.id}`,
        providerId: this.providerId,
        providerModelId: model.id,
        contextLength: context.length ? Math.max(...context) : null,
        // Hugging Face routes to third-party providers that charge their own
        // rates, and the free monthly credit is an account property rather than
        // a model one. Meridian does not know which applies to this operator,
        // so the rate stays unknown rather than being guessed either way.
        pricing: UNKNOWN_RATE('Routed to a third-party provider at its own rate, against a monthly credit.'),
        capabilities: Object.keys(caps).length ? caps : undefined,
        provenance,
        confidence: 'VERIFIED',
      });
    }

    return {
      metadata: this.metadata,
      version: null,
      generated: provenance.lastVerified,
      fetchedAt: result.fetchedAt ?? ctx.now,
      fromCache: result.fromCache,
      cacheAgeDays: result.cacheAgeDays,
      providers: [
        {
          providerId: this.providerId,
          descriptor: null,
          intelligence: {
            providerId: this.providerId,
            // A monthly credit that renews and then stops. It is not a free
            // tier and it is not a trial: it is its own thing, and the taxonomy
            // has a word for it precisely so this does not get rounded to
            // "free".
            freeAccess: 'RECURRING_CREDIT',
            freeTierSummary: 'A monthly inference credit on a free account; paid rates apply once it is spent.',
            rateLimitSummary: null,
            caveat:
              'Requests are routed to third-party providers at their own rates. Once the monthly credit is spent, calls cost money — so this is not a zero-cost route.',
            bestFor: 'Reaching open-weight models without an account at each provider that serves them.',
            expires: null,
            requirements: { apiKey: 'yes', account: 'yes', card: 'no', phone: 'unknown' },
            commercialUse: 'unknown',
            openAiCompatible: 'yes',
            openAiBaseUrl: 'https://router.huggingface.co/v1',
            freeModelIds: [],
            modalities: ['text'],
            provenance,
          },
          unroutableReason: 'already-shipped',
        },
      ],
      models,
      error: result.error,
    };
  }
}

/* ------------------------------------------------------------------ */

export function nativeSources(): DiscoverySource[] {
  return [new OpenRouterSource(), new PollinationsSource(), new HuggingFaceSource()];
}
