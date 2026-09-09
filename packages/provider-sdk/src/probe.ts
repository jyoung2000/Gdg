/**
 * Finding out what a model can actually do, by asking it.
 *
 * Everything Meridian knew about a model's capabilities before this came from
 * one of two places: the provider's own listing, which is marketing as often as
 * it is specification, or a regular expression over the model's name, which is
 * a guess wearing a fact's clothing. `probe_verified` sat at the top of the
 * evidence ranking with nothing able to produce it, the UI offered a
 * "Verified by a live call" label no model could earn, and the computer-use
 * router awarded it a scoring bonus that was never once claimed.
 *
 * A probe is a real request. That is the point and also the constraint: it
 * costs money and quota, so every probe here is built to be the smallest
 * request that can still distinguish "does this" from "does not".
 *
 * ## What a probe may conclude
 *
 * Three outcomes, and the third is the one that keeps this honest:
 *
 * - **supported** — the model did the thing. Strong evidence, and the only
 *   thing that writes `probe_verified`.
 * - **unsupported** — the provider gave a *definitive* refusal: it rejected the
 *   request shape itself, saying this model does not take images, or tools, or
 *   whatever was asked for. Also strong evidence, in the other direction.
 * - **inconclusive** — everything else. A timeout, a 429, a 500, an auth
 *   failure, a network blip. These say something about the day, not about the
 *   model, and writing a capability claim from one would poison the registry
 *   with transient noise. They produce no claim at all.
 *
 * The distinction between the second and the third is the whole design. It is
 * why probes classify the error rather than treating any failure as a "no".
 */
import {
  MeridianError,
  type Capability,
  type CapabilityClaim,
  type ChatMessage,
  type ModelDescriptor,
  type ToolDefinition,
} from '@meridian/shared';
import type { AdapterContext, ProviderAdapter } from './adapter.js';

export type ProbeOutcome = 'supported' | 'unsupported' | 'inconclusive';

export interface ProbeResult {
  capability: Capability;
  outcome: ProbeOutcome;
  /** What happened, in words, for the evidence record and the CLI. */
  detail: string;
  latencyMs: number;
  /** Tokens the probe actually consumed, when the provider reported them. */
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ProbeOptions {
  /** Probes to run. Defaults to those the model plausibly has. */
  capabilities?: Capability[];
  /** Per-probe timeout. Deliberately short: a probe is a small request. */
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * A 1×1 transparent PNG.
 *
 * The smallest thing that is unambiguously an image. A model that accepts it
 * has an image path; one that rejects the *shape* does not. Deliberately not a
 * picture of anything — this probe asks whether images are accepted, not
 * whether the model can describe them, and a bigger image would cost more
 * tokens to answer the same question.
 */
export const PROBE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The smallest tool that still has a required argument to fill in. */
export const PROBE_TOOL: ToolDefinition = {
  name: 'meridian_probe',
  description: 'Report readiness. Call this tool with ok set to true.',
  parameters: {
    type: 'object',
    properties: { ok: { type: 'boolean', description: 'Always true.' } },
    required: ['ok'],
  },
};

/**
 * Error codes that describe the request rather than the moment.
 *
 * `invalid_request` is a provider saying "this is not a thing I accept" —
 * which, for a probe whose entire payload is the capability under test, means
 * the capability is absent. Everything else (rate limits, timeouts, upstream
 * faults, bad credentials) is about conditions, and conditions change.
 */
const DEFINITIVE_REFUSALS = new Set(['invalid_request', 'unsupported_capability']);

/**
 * Optional generation parameters the probes send, and which some models refuse.
 *
 * A reasoning model that rejects `temperature` says so with an
 * `invalid_request` naming the parameter — the same code, and very nearly the
 * same words, as a model saying it cannot see images. Read as a capability
 * refusal it deletes a capability the model has. So a rejection that names one
 * of our own optional parameters is not a verdict: the probe is re-sent
 * without them, and only what comes back from *that* is allowed to become a
 * claim.
 */
const OPTIONAL_PARAM_PHRASES = [
  /\btemperature\b/i,
  /\bmax_tokens\b/i,
  /\bmax_completion_tokens\b/i,
  /\bmaxtokens\b/i,
  /\btop_p\b/i,
];

/**
 * Phrases a provider uses when the *model* cannot do this, inside an error that
 * would otherwise look generic. Matched case-insensitively against the message.
 */
const REFUSAL_PHRASES = [
  /does not support/i,
  /is not supported/i,
  /unsupported (parameter|value|feature|model)/i,
  /no support for/i,
  /not (a )?(vision|multimodal)/i,
  /image (input|url)s? (are|is) not/i,
  /tool (use|calling|choice) is not/i,
];

/**
 * What a failed probe is allowed to mean.
 *
 * `parameter-refused` is not a verdict — it is a request to ask again without
 * the optional parameters this probe added, since the refusal named one of
 * them rather than the capability under test. `retry` is false on that second
 * attempt so a provider that simply always says "temperature" cannot loop.
 */
export function classify(error: unknown, retry = true): { outcome: 'unsupported' | 'inconclusive' | 'parameter-refused'; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof MeridianError ? error.code : null;

  // A 404 is the provider saying this model id is not one it serves. That is a
  // fact about the model's existence, not about what the model can do, and
  // treating it as a capability refusal deleted capabilities from the registry
  // every time a provider retired an id the catalogue still listed.
  if (code === 'model_unavailable') {
    return { outcome: 'inconclusive', detail: `the provider does not serve this model id: ${message}` };
  }
  // Checked before anything else can read it as a capability answer: the same
  // code and nearly the same words carry both meanings.
  if (retry && code === 'invalid_request' && OPTIONAL_PARAM_PHRASES.some((re) => re.test(message))) {
    return { outcome: 'parameter-refused', detail: `the provider refused one of the probe's own parameters: ${message}` };
  }
  if (code && DEFINITIVE_REFUSALS.has(code)) {
    return { outcome: 'unsupported', detail: `provider rejected the request (${code}): ${message}` };
  }
  if (REFUSAL_PHRASES.some((re) => re.test(message))) {
    return { outcome: 'unsupported', detail: `provider said the model does not do this: ${message}` };
  }
  // A 429, a 500, a timeout, an expired key. None of these are facts about the
  // model, so none of them may become a claim about it.
  return { outcome: 'inconclusive', detail: `probe could not reach a verdict: ${message}` };
}

/**
 * Which capabilities are worth probing for a model, given what it claims.
 *
 * Every entry here becomes a real request, so the list is kept to probes that
 * could plausibly tell us something. An embedding model is the clear case: it
 * has no chat surface to call a tool from, and probing it for tools spends a
 * request to learn that an embedding endpoint is an embedding endpoint.
 */
export function probeableCapabilities(model: ModelDescriptor, adapter: ProviderAdapter): Capability[] {
  const surface = adapter.surface();
  const embeddingOnly = model.modalities.length > 0 && model.modalities.every((m) => m === 'embedding');
  const out: Capability[] = [];

  if (surface.embedding && model.modalities.includes('embedding')) out.push('embedding');
  if (embeddingOnly) return out;

  // `text` is the cheapest probe and the one that proves the model can be
  // called at all, so it leads for anything with a chat surface.
  if (surface.chat) out.push('text');
  if (surface.tools) out.push('tools');
  if (surface.vision) out.push('vision');
  return out;
}

/**
 * Run one probe.
 *
 * Never throws: a probe that fails is a result, because the caller is usually
 * probing many models and one provider having a bad minute must not end the
 * run.
 */
export async function probeCapability(
  adapter: ProviderAdapter,
  model: ModelDescriptor,
  capability: Capability,
  ctx: AdapterContext,
): Promise<ProbeResult> {
  const started = Date.now();
  const base = { capability, promptTokens: null, completionTokens: null };

  const run = async (tuning: Tuning): Promise<PartialResult | null> => {
    switch (capability) {
      case 'text':
        return probeText(adapter, model, ctx, tuning);
      case 'tools':
        return probeTools(adapter, model, ctx, tuning);
      case 'vision':
        return probeVision(adapter, model, ctx, tuning);
      case 'embedding':
        return probeEmbedding(adapter, model, ctx);
      default:
        return null;
    }
  };

  try {
    const result = await run(WITH_TUNING);
    if (!result) {
      return { ...base, outcome: 'inconclusive', detail: `no probe is defined for "${capability}"`, latencyMs: Date.now() - started };
    }
    return { ...result, capability, latencyMs: Date.now() - started };
  } catch (e) {
    const first = classify(e);
    if (first.outcome !== 'parameter-refused') {
      return { ...base, outcome: first.outcome, detail: first.detail, latencyMs: Date.now() - started };
    }
    // Ask again with nothing optional attached, so the answer is about the
    // capability rather than about `temperature`.
    try {
      const result = await run(NO_TUNING);
      if (!result) {
        return { ...base, outcome: 'inconclusive', detail: `no probe is defined for "${capability}"`, latencyMs: Date.now() - started };
      }
      return { ...result, capability, latencyMs: Date.now() - started };
    } catch (again) {
      const second = classify(again, false);
      return {
        ...base,
        outcome: second.outcome === 'parameter-refused' ? 'inconclusive' : second.outcome,
        detail: `${second.detail} (after retrying without the probe's optional parameters)`,
        latencyMs: Date.now() - started,
      };
    }
  }
}

/**
 * Whether a probe attaches its optional generation parameters.
 *
 * `maxTokens` and `temperature` make a probe cheap — five tokens rather than a
 * paragraph — and deterministic, which is worth having. They are also the
 * parameters a capable model is most likely to refuse, so every probe can be
 * run without them and asked again.
 */
type Tuning = 'with-optional-params' | 'without-optional-params';

const WITH_TUNING: Tuning = 'with-optional-params';
const NO_TUNING: Tuning = 'without-optional-params';

/** The optional half of a probe's payload, or nothing at all. */
function tuned(tuning: Tuning, maxTokens: number): { maxTokens?: number; temperature?: number } {
  return tuning === WITH_TUNING ? { maxTokens, temperature: 0 } : {};
}

type PartialResult = Omit<ProbeResult, 'capability' | 'latencyMs'>;

/** The cheapest possible generation: one token, one word back. */
async function probeText(adapter: ProviderAdapter, model: ModelDescriptor, ctx: AdapterContext, tuning: Tuning): Promise<PartialResult> {
  if (!adapter.chat) return { outcome: 'inconclusive', detail: 'adapter has no chat method', promptTokens: null, completionTokens: null };
  const res = await adapter.chat(
    {
      model: model.providerModelId,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      ...tuned(tuning, 5),
    },
    ctx,
  );
  const text = res.content.trim();
  return {
    outcome: text.length > 0 ? 'supported' : 'inconclusive',
    detail: text.length > 0 ? `answered with ${JSON.stringify(text.slice(0, 40))}` : 'answered with nothing',
    promptTokens: res.usage?.promptTokens ?? null,
    completionTokens: res.usage?.completionTokens ?? null,
  };
}

/**
 * Offer one trivial tool and require it.
 *
 * `toolChoice: 'required'` is what makes this a real test rather than a
 * suggestion: a model that *can* call tools but chooses not to would otherwise
 * be indistinguishable from one that cannot. Where a provider rejects
 * `required` itself, that rejection is classified like any other and comes back
 * inconclusive rather than as a false negative.
 */
async function probeTools(adapter: ProviderAdapter, model: ModelDescriptor, ctx: AdapterContext, tuning: Tuning): Promise<PartialResult> {
  if (!adapter.chat) return { outcome: 'inconclusive', detail: 'adapter has no chat method', promptTokens: null, completionTokens: null };
  const res = await adapter.chat(
    {
      model: model.providerModelId,
      messages: [{ role: 'user', content: 'Call the meridian_probe tool with ok set to true.' }],
      tools: [PROBE_TOOL],
      toolChoice: 'required',
      ...tuned(tuning, 64),
    },
    ctx,
  );
  const calls = res.toolCalls ?? [];
  return {
    outcome: calls.length > 0 ? 'supported' : 'inconclusive',
    detail: calls.length > 0 ? `called ${calls.map((c) => c.name).join(', ')}` : 'returned text instead of a tool call',
    promptTokens: res.usage?.promptTokens ?? null,
    completionTokens: res.usage?.completionTokens ?? null,
  };
}

/**
 * Send a 1×1 PNG and see whether the request is accepted at all.
 *
 * What the model *says* about the image is deliberately not checked: a 1×1
 * transparent pixel has nothing to describe, and grading the answer would test
 * the model's eyesight rather than the provider's willingness to carry an
 * image. Acceptance is the capability.
 */
async function probeVision(adapter: ProviderAdapter, model: ModelDescriptor, ctx: AdapterContext, tuning: Tuning): Promise<PartialResult> {
  if (!adapter.chat) return { outcome: 'inconclusive', detail: 'adapter has no chat method', promptTokens: null, completionTokens: null };
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with the single word: ok' },
        { type: 'image', url: PROBE_PNG, mimeType: 'image/png' },
      ],
    },
  ];
  const res = await adapter.chat({ model: model.providerModelId, messages, ...tuned(tuning, 5) }, ctx);
  const text = res.content.trim();
  return {
    outcome: text.length > 0 ? 'supported' : 'inconclusive',
    detail: text.length > 0 ? 'accepted an image in the message content' : 'accepted the image but returned nothing',
    promptTokens: res.usage?.promptTokens ?? null,
    completionTokens: res.usage?.completionTokens ?? null,
  };
}

async function probeEmbedding(adapter: ProviderAdapter, model: ModelDescriptor, ctx: AdapterContext): Promise<PartialResult> {
  if (!adapter.embed) return { outcome: 'inconclusive', detail: 'adapter has no embed method', promptTokens: null, completionTokens: null };
  const res = await adapter.embed({ model: model.providerModelId, input: ['ok'] }, ctx);
  const dims = res.embeddings?.[0]?.length ?? 0;
  return {
    outcome: dims > 0 ? 'supported' : 'inconclusive',
    detail: dims > 0 ? `returned a ${dims}-dimension vector` : 'returned no vector',
    promptTokens: res.usage?.promptTokens ?? null,
    completionTokens: null,
  };
}

/**
 * Turn a probe result into an evidence claim — or into nothing.
 *
 * An inconclusive probe returns null on purpose. It is the rule that keeps a
 * rate limit from being recorded as "this model has no vision", and it is why
 * a probe run over a flaky provider degrades to "learned nothing" instead of
 * to a registry full of false negatives.
 */
export function claimFrom(result: ProbeResult, at: number): CapabilityClaim | null {
  if (result.outcome === 'inconclusive') return null;
  return {
    state: result.outcome === 'supported' ? 'probe_verified' : 'unsupported',
    source: `live probe: ${result.detail}`,
    // A probe is the only evidence Meridian gathers itself, first-hand.
    confidence: 1,
    at,
  };
}

export interface ModelProbeReport {
  modelId: string;
  providerId: string;
  results: ProbeResult[];
  /** Claims worth persisting; excludes every inconclusive probe. */
  claims: Partial<Record<Capability, CapabilityClaim>>;
}

/**
 * Probe one model across several capabilities, in sequence.
 *
 * Sequential on purpose: these are real requests against someone's rate limit,
 * and a burst of parallel probes is the fastest way to earn a 429 that makes
 * every one of them inconclusive.
 */
export async function probeModel(
  adapter: ProviderAdapter,
  model: ModelDescriptor,
  ctx: AdapterContext,
  opts: ProbeOptions = {},
): Promise<ModelProbeReport> {
  const now = opts.now ?? Date.now;
  const capabilities = opts.capabilities ?? probeableCapabilities(model, adapter);
  const results: ProbeResult[] = [];
  const claims: Partial<Record<Capability, CapabilityClaim>> = {};

  for (const capability of capabilities) {
    if (opts.signal?.aborted) break;
    const result = await probeCapability(adapter, model, capability, {
      ...ctx,
      timeoutMs: opts.timeoutMs ?? Math.min(ctx.timeoutMs, 30_000),
      signal: opts.signal ?? ctx.signal,
    });
    results.push(result);
    const claim = claimFrom(result, now());
    if (claim) claims[capability] = claim;
  }

  return { modelId: model.id, providerId: model.providerId, results, claims };
}
