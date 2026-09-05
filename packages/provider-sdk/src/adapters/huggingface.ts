import {
  MeridianError,
  classifyUnknown,
  computeCost,
  modelKey,
  newId,
  type GeneratedAsset,
  type ImageRequest,
  type ImageResponse,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext } from '../adapter.js';
import { httpJson, httpRequest, toDataUrl } from '../http.js';
import { OpenAICompatibleAdapter, familyOf } from './openai-compatible.js';

/** The origins Hugging Face serves outside the OpenAI-compatible router. */
export interface HuggingFaceHosts {
  /** Classic per-model Inference API; text-to-image answers with raw bytes. */
  inference: string;
  /** The Hub, which publishes the model index and the token's identity. */
  hub: string;
}

const DEFAULT_HOSTS: HuggingFaceHosts = {
  inference: 'https://api-inference.huggingface.co',
  hub: 'https://huggingface.co',
};

/**
 * The free allowance is a cap, not an open tap, so plain FREE would be a lie
 * the router acts on: it would keep sending work here long after the quota is
 * spent. Rates stay null because what a call costs past the allowance depends
 * on which upstream provider the router picked, which no listing reports.
 */
const FREE_TIER_PRICING: Pricing = {
  kind: 'FREE_DAILY',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  freeQuota: null,
  note: 'Free Hugging Face inference is capped and the allowance varies by account tier; past it, calls are billed by the upstream provider or refused.',
};

const SUPPORTED: AdapterCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  vision: true,
  embedding: false,
  image: true,
  video: false,
  speech: false,
  transcription: false,
  discovery: true,
  health: true,
};

/** Fields of the Hub model index this adapter actually reads. */
interface HubModel {
  id?: string;
  modelId?: string;
  pipeline_tag?: string;
  gated?: boolean | string;
}

/**
 * Hugging Face, which is two products behind one token.
 *
 * Text generation goes through the Inference Providers router at
 * `https://router.huggingface.co/v1`, an OpenAI-compatible proxy in front of
 * whichever upstream serves the repo — so chat and streaming are the base
 * class unchanged, and the descriptor's baseUrl names that router.
 *
 * Image generation does not go through the router. It is the classic
 * per-model Inference API (`POST /models/{repo}`), which takes `inputs` plus a
 * `parameters` object and answers with the encoded image rather than a JSON
 * envelope. Nothing about that matches `/images/generations`, so the inherited
 * implementation is replaced outright.
 *
 * Embeddings, speech and transcription are inherited but declared false: the
 * base guards each of them on capabilities() and raises unsupported_capability
 * instead of posting to a route this provider does not serve.
 */
export class HuggingFaceAdapter extends OpenAICompatibleAdapter {
  private readonly hosts: HuggingFaceHosts;

  constructor(descriptor: ProviderDescriptor, hosts: Partial<HuggingFaceHosts> = {}) {
    super(descriptor, {
      supports: SUPPORTED,
      // Neither listing carries prices, and the router's per-model rates move
      // with the upstream provider, so discovered models inherit the capped
      // free tier unless the static catalog knows better.
      pricingForDiscovered: () => FREE_TIER_PRICING,
    });
    this.hosts = { ...DEFAULT_HOSTS, ...hosts };
  }

  /**
   * Declared outright rather than left to the base merge, because the image
   * surface is this adapter's own and discovery reaches the Hub index even
   * when the descriptor does not flag the router as discoverable.
   */
  override capabilities(): AdapterCapabilities {
    return { ...SUPPORTED };
  }

  /**
   * A descriptor holds one baseUrl, which the inherited chat path spends on
   * the router; these two origins have no slot in it. An explicit ctx.baseUrl
   * (test double, mirror) still stands in for every surface.
   */
  private host(ctx: AdapterContext, surface: keyof HuggingFaceHosts): string {
    return (ctx.baseUrl ?? this.hosts[surface]).replace(/\/+$/, '');
  }

  /** An operator override wins, but the fallback is the capped tier, not the descriptor default. */
  private pricingFor(model: string): Pricing {
    return this.pricingLookup(model) ?? FREE_TIER_PRICING;
  }

  /** Per-call timeout that can never outlive the overall deadline. */
  private budget(deadline: number, cap: number): number {
    return Math.max(1, Math.min(cap, deadline - Date.now()));
  }

  override async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    // The router publishes what serves chat; the classic endpoint publishes
    // nothing at all, so the image side comes from the Hub's model index.
    const [text, image] = await Promise.all([super.listModels(ctx), this.listImageModels(ctx)]);
    // Two independent indexes, and model ids have to stay unique. A repo in
    // both keeps its router entry, which is the one carrying a context length.
    const byId = new Map<string, ModelDescriptor>();
    for (const m of image) byId.set(m.id, m);
    for (const m of text) byId.set(m.id, m);
    return [...byId.values()];
  }

  /** Hub model index: `GET /api/models`, the same listing the Hub site is built on. */
  private async listImageModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const url = new URL(`${this.host(ctx, 'hub')}/api/models`);
    url.searchParams.set('filter', 'text-to-image');
    url.searchParams.set('sort', 'likes');
    // The Hub sorts ascending unless told otherwise, so without a direction the
    // slice `limit` takes is the fifty least-liked repos rather than the top fifty.
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '50');

    const entries = await httpJson<HubModel[]>(url.toString(), {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
    });
    if (!Array.isArray(entries)) {
      throw new MeridianError('server_error', 'Hugging Face model index did not return a list', {
        providerId: this.descriptor.id,
      });
    }

    const out: ModelDescriptor[] = [];
    for (const entry of entries) {
      const id = typeof entry.id === 'string' ? entry.id : typeof entry.modelId === 'string' ? entry.modelId : null;
      if (!id) continue;
      // Gated repos answer 403 until a licence is accepted on the Hub by hand,
      // and a model the token cannot call has no business in the routing table.
      if (entry.gated) continue;
      out.push({
        id: modelKey(this.descriptor.id, id),
        providerId: this.descriptor.id,
        providerModelId: id,
        displayName: id,
        family: familyOf(id),
        modalities: ['image'],
        capabilities: ['image-generation'],
        contextLength: null,
        maxOutputTokens: null,
        pricing: this.pricingFor(id),
        discovered: true,
        deprecated: false,
        tags: [entry.pipeline_tag ?? 'text-to-image'],
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  /**
   * `GET /api/whoami-v2` rather than a model listing: both listings answer
   * anonymous callers, so a 200 from either proves nothing about the token
   * this provider was configured with. whoami spends no inference allowance
   * and returns 401 the moment the token stops working.
   */
  override async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await httpRequest(`${this.host(ctx, 'hub')}/api/whoami-v2`, {
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

  override async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    const model = req.model?.trim();
    // The endpoint is the model: there is no default repo to fall back to.
    if (!model) {
      throw new MeridianError('invalid_request', 'Hugging Face image generation requires a model repo id', {
        providerId: this.descriptor.id,
      });
    }
    if (req.referenceImage) {
      // image-to-image is a different task with a different body; accepting the
      // reference here and dropping it would return an unrelated picture.
      throw new MeridianError('unsupported_capability', 'The Hugging Face text-to-image endpoint takes no reference image', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }

    const started = Date.now();
    // ctx.timeoutMs bounds the whole call, not each leg of it: handing all n
    // sequential requests the full timeout would overrun the caller's deadline
    // n-fold, leaving the fallback engine blocked on a provider it has already
    // given up on.
    const deadline = started + ctx.timeoutMs;
    const count = Math.max(1, Math.floor(req.n ?? 1));
    const assets: GeneratedAsset[] = [];
    for (let i = 0; i < count; i++) {
      // A signal that aborted between requests never reaches the transport,
      // which only learns about an abort raised while a call is in flight.
      if (ctx.signal?.aborted) {
        throw new MeridianError('cancelled', 'Image generation cancelled', {
          providerId: this.descriptor.id,
          modelId: model,
          details: { produced: assets.length, requested: count },
        });
      }
      if (Date.now() >= deadline) {
        throw new MeridianError(
          'timeout',
          `Hugging Face produced ${assets.length} of ${count} images within ${ctx.timeoutMs}ms`,
          {
            providerId: this.descriptor.id,
            modelId: model,
            details: { produced: assets.length, requested: count },
          },
        );
      }
      // One call yields exactly one image. Offsetting the caller's seed keeps
      // a multi-image set reproducible, and the calls run one at a time because
      // the allowance is per account: parallelism buys 429s, not wall clock.
      const seed = req.seed != null ? req.seed + i : null;
      assets.push(await this.generateOne(req, model, seed, deadline, ctx));
    }

    return {
      id: newId('img'),
      model,
      providerId: this.descriptor.id,
      assets,
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: computeCost(this.pricingFor(model), 0, 0, assets.length),
      },
    };
  }

  private async generateOne(
    req: ImageRequest,
    model: string,
    seed: number | null,
    deadline: number,
    ctx: AdapterContext,
  ): Promise<GeneratedAsset> {
    const parameters: Record<string, unknown> = {};
    if (req.negativePrompt) parameters.negative_prompt = req.negativePrompt;
    if (req.width) parameters.width = req.width;
    if (req.height) parameters.height = req.height;
    if (req.steps) parameters.num_inference_steps = req.steps;
    if (req.guidance != null) parameters.guidance_scale = req.guidance;
    if (seed != null) parameters.seed = seed;

    const body: Record<string, unknown> = { inputs: req.prompt };
    // Sent only when the caller pinned something, so an untouched request
    // leaves each pipeline's own defaults in charge.
    if (Object.keys(parameters).length > 0) body.parameters = parameters;

    let res: Response;
    try {
      res = await httpRequest(`${this.host(ctx, 'inference')}/models/${encodeRepoId(model)}`, {
        headers: this.headers(ctx, { accept: 'image/*' }),
        body,
        timeoutMs: this.budget(deadline, ctx.timeoutMs),
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      });
    } catch (e) {
      throw asModelLoading(e, this.descriptor.id, model);
    }

    // The body is the image itself, so the content type is the only signal that
    // a JSON error page slipped through with a 200 — which is what a repo that
    // is not a text-to-image pipeline returns.
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!mimeType.startsWith('image/') || bytes.byteLength === 0) {
      throw new MeridianError('server_error', `Hugging Face returned ${mimeType || 'an empty body'} rather than image bytes`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: { contentType: mimeType, bytes: bytes.byteLength },
      });
    }
    return {
      url: toDataUrl(bytes, mimeType),
      mimeType,
      width: req.width,
      height: req.height,
      seed,
      bytes: bytes.byteLength,
    };
  }
}

/** Repo ids carry a slash that has to stay a path separator, not become %2F. */
function encodeRepoId(model: string): string {
  return model.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * A cold model answers `503 {"error": "... is currently loading", "estimated_time": 27.4}`.
 * httpRequest classifies every 5xx as server_error, which the fallback engine
 * retries after a short generic cooldown — hammering weights that are provably
 * not up yet. Re-raising it as provider_unavailable with the published estimate
 * as retryAfterSec parks this provider for as long as the load is expected to
 * take. The `x-wait-for-model` header would instead block until the model is
 * ready, but that spends the caller's whole timeout here rather than letting
 * the chain serve the request somewhere else.
 */
function asModelLoading(e: unknown, providerId: string, modelId: string): MeridianError {
  if (!(e instanceof MeridianError)) return classifyUnknown(e, providerId, modelId);
  if (e.details.status !== 503) return e;
  const body = typeof e.details.body === 'string' ? e.details.body : '';
  let estimate: unknown;
  try {
    estimate = (JSON.parse(body) as { estimated_time?: unknown }).estimated_time;
  } catch {
    return e; // Any other 503 is a genuine outage and keeps its classification.
  }
  if (typeof estimate !== 'number' || !Number.isFinite(estimate)) return e;
  const seconds = Math.max(1, Math.ceil(estimate));
  return new MeridianError('provider_unavailable', `Hugging Face is still loading ${modelId} (ready in ~${seconds}s)`, {
    providerId,
    modelId,
    retryAfterSec: seconds,
    cause: e,
  });
}
