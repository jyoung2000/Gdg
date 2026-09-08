import {
  MeridianError,
  modelKey,
  type Capability,
  type Modality,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type Usage,
} from '@meridian/shared';
import type { AdapterSurface, AdapterContext } from '../adapter.js';
import { httpJson, httpRequest } from '../http.js';
import { OpenAICompatibleAdapter, familyOf } from './openai-compatible.js';

/**
 * Local inference is paid for in electricity, not credit. Every rate stays null
 * because there is no published price to report — not because one is unknown.
 */
const LOCAL_PRICING: Pricing = {
  kind: 'LOCAL',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: 'Runs on operator-owned hardware',
};

/** Ollama's native `/api/tags` entry. */
interface OllamaTagEntry {
  name?: string;
  model?: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagEntry[];
}

/**
 * `/api/tags` reports no capability flags, so the only signal available is the
 * model tag itself. These patterns cover the families Ollama actually ships;
 * anything unrecognised falls back to plain text, which under-claims rather
 * than inventing a capability the local weights may not have.
 */
const EMBEDDING_HINT = /embed/;
const VISION_HINT = /llava|vision|gemma3|qwen2\.5vl|minicpm-v/;
const CODING_HINT = /coder|code/;

const OLLAMA_CAPABILITIES: AdapterSurface = {
  chat: true,
  streaming: true,
  // These describe the surface, not the weights: Ollama serves tool calls and
  // image inputs, but only for models whose template declares them, and
  // `/api/tags` does not say which do.
  tools: true,
  vision: true,
  embedding: true,
  image: false,
  video: false,
  speech: false,
  transcription: false,
  discovery: true,
  health: true,
};

/**
 * Ollama.
 *
 * Chat, streaming and embeddings ride the OpenAI-compatible surface Ollama
 * serves at `{base}/v1`, so the base class handles them unchanged. Discovery
 * and health use the native REST API (`GET /api/tags`) instead: it is the only
 * listing that carries family, parameter size and quantisation, and it answers
 * even when no model has ever been loaded.
 */
export class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor(descriptor: ProviderDescriptor) {
    super(descriptor, { supports: OLLAMA_CAPABILITIES });
  }

  override surface(): AdapterSurface {
    return { ...OLLAMA_CAPABILITIES };
  }

  /**
   * The descriptor points at the OpenAI-compatible surface, which lives one
   * level below the native API — strip the suffix to reach `/api/*`.
   */
  protected nativeRoot(ctx: AdapterContext): string {
    return this.baseUrl(ctx).replace(/\/v1$/, '');
  }

  override async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const json = await httpJson<OllamaTagsResponse>(`${this.nativeRoot(ctx)}/api/tags`, {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
    });
    const out: ModelDescriptor[] = [];
    for (const entry of json.models ?? []) {
      const mapped = this.toDescriptor(entry);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  private toDescriptor(entry: OllamaTagEntry): ModelDescriptor | null {
    // `model` is the id an API call must use; `name` is the same tag as shown
    // in the CLI. Older daemons send only one of the two.
    const id = entry.model ?? entry.name;
    if (!id) return null;
    const lower = id.toLowerCase();
    const embedding = EMBEDDING_HINT.test(lower);
    const vision = !embedding && VISION_HINT.test(lower);

    const modalities: Modality[] = embedding ? ['embedding'] : vision ? ['text', 'vision'] : ['text'];
    // The router drops any model whose descriptor omits `tools`, so a chat model
    // has to carry the adapter's tool flag or Ollama could never be selected for
    // tool use at all. Which templates declare tools is not discoverable, so
    // this tracks the surface, exactly as the OpenAI-compatible mapper does.
    const capabilities: Capability[] = embedding ? ['embedding'] : ['text', 'streaming', 'tools'];
    if (vision) capabilities.push('vision');

    // Parameter size and quantisation are how an operator actually chooses
    // between two copies of the same family, so they are worth surfacing.
    const tags = ['local'];
    if (CODING_HINT.test(lower)) tags.push('coding');
    if (entry.details?.parameter_size) tags.push(entry.details.parameter_size);
    if (entry.details?.quantization_level) tags.push(entry.details.quantization_level);

    return {
      id: modelKey(this.descriptor.id, id),
      providerId: this.descriptor.id,
      providerModelId: id,
      displayName: entry.name ?? id,
      family: entry.details?.family ?? familyOf(id),
      modalities,
      capabilities,
      // The tag listing carries no context window. Leaving it null keeps the
      // router from filtering on a number we would have had to guess.
      contextLength: null,
      maxOutputTokens: null,
      pricing: LOCAL_PRICING,
      discovered: true,
      deprecated: false,
      tags,
      updatedAt: Date.now(),
    };
  }

  override async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await httpRequest(`${this.nativeRoot(ctx)}/api/tags`, {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: Math.min(ctx.timeoutMs, 15_000),
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Token counts still matter for context accounting; the price never does. */
  protected override usageFor(
    model: string,
    raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  ): Usage {
    return { ...super.usageFor(model, raw), cost: 0 };
  }
}

/**
 * Any other OpenAI-compatible server the operator runs themselves — vLLM,
 * llama.cpp's `llama-server`, LM Studio, text-generation-webui.
 *
 * Only chat and streaming are assumed: every one of these serves
 * `/v1/chat/completions` with SSE. Tools, vision and embeddings depend on the
 * launch flags and the loaded weights, so they are opt-in per deployment rather
 * than advertised on the operator's behalf.
 */
export class GenericOpenAIServerAdapter extends OpenAICompatibleAdapter {
  constructor(descriptor: ProviderDescriptor, supports: Partial<AdapterSurface> = {}) {
    super(descriptor, {
      supports: { chat: true, streaming: true, ...supports },
      pricingForDiscovered: () => LOCAL_PRICING,
    });
  }

  protected override usageFor(
    model: string,
    raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  ): Usage {
    return { ...super.usageFor(model, raw), cost: 0 };
  }
}

export interface LocalEndpoint {
  /**
   * The OpenAI-compatible surface, normalised so it can be dropped straight
   * into a `ProviderDescriptor` regardless of which form the caller probed.
   */
  baseUrl: string;
  kind: 'ollama' | 'openai-compatible';
  models: string[];
  latencyMs: number;
}

/** Probes are unauthenticated and belong to no provider yet. */
const DISCOVERY_ID = 'local-discovery';

/**
 * A loopback service either answers immediately or is not there. Capping the
 * probe keeps scanning a list of candidate ports from stalling on a port that
 * is open but silent.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Scan candidate base URLs for a local inference server.
 *
 * Targets Ollama's native `GET /api/tags` and the OpenAI listing route, tried
 * in that order because an Ollama daemon answers both and only `/api/tags`
 * identifies it.
 */
export async function discoverLocalEndpoints(
  baseUrls: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalEndpoint[]> {
  const overallMs = Math.max(1, opts.timeoutMs);
  const deadline = Date.now() + overallMs;
  const probeMs = Math.min(overallMs, PROBE_TIMEOUT_MS);
  const found = await Promise.all(baseUrls.map((url) => probeEndpoint(url, deadline, probeMs, opts.signal)));
  // A cancelled scan finds nothing, which is not the same answer as "nothing is
  // running here" — reporting the second would have the caller tear down local
  // providers that are perfectly alive.
  if (opts.signal?.aborted) {
    throw new MeridianError('cancelled', 'Local endpoint discovery cancelled', { providerId: DISCOVERY_ID });
  }
  return found.filter((e): e is LocalEndpoint => e !== null);
}

async function probeEndpoint(
  baseUrl: string,
  deadline: number,
  probeMs: number,
  signal?: AbortSignal,
): Promise<LocalEndpoint | null> {
  const root = baseUrl.replace(/\/+$/, '');
  // Callers often hold the OpenAI-compatible URL; the native API sits above it.
  const native = root.replace(/\/v1$/, '');
  // Three probes run in sequence, so each may only spend what is left of the
  // caller's budget; otherwise a host that is open but silent costs three full
  // probe timeouts instead of the one the caller asked for.
  const budget = (): number => Math.min(probeMs, deadline - Date.now());

  const tagsStarted = Date.now();
  const tagsMs = budget();
  const tags =
    tagsMs > 0 && !signal?.aborted ? await probeJson<OllamaTagsResponse>(`${native}/api/tags`, tagsMs, signal) : null;
  const tagged = tags ? ollamaModelNames(tags.models) : null;
  if (tagged) return { baseUrl: `${native}/v1`, kind: 'ollama', models: tagged, latencyMs: Date.now() - tagsStarted };

  // Servers disagree on whether the version prefix is part of the base URL.
  // Both candidates are built from the stripped root so that a caller who
  // already passed `.../v1` is not probed at `.../v1/v1`, and whichever one
  // answered is the base reported back.
  for (const base of [`${native}/v1`, native]) {
    const ms = budget();
    if (ms <= 0 || signal?.aborted) break;
    const started = Date.now();
    const listing = await probeJson<{ data?: unknown; models?: unknown }>(`${base}/models`, ms, signal);
    const ids = listing ? openAIModelIds(listing.data ?? listing.models) : null;
    if (ids) return { baseUrl: base, kind: 'openai-compatible', models: ids, latencyMs: Date.now() - started };
  }
  return null;
}

/**
 * A closed port, an HTTP error and a body that is not a model listing are all
 * the same uninteresting answer: nothing is running here. Nothing about a probe
 * is worth propagating to the caller.
 */
async function probeJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  try {
    return await httpJson<T>(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs,
      signal,
      providerId: DISCOVERY_ID,
    });
  } catch {
    return null;
  }
}

/** null when the payload is not a model list at all; [] when the host has none pulled. */
function ollamaModelNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw as OllamaTagEntry[]) {
    const name = entry?.model ?? entry?.name;
    if (typeof name === 'string' && name) out.push(name);
  }
  return out;
}

function openAIModelIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const id = entry?.id ?? entry?.name;
    if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}
