import {
  MeridianError,
  computeCost,
  modelKey,
  newId,
  type GeneratedAsset,
  type ImageRequest,
  type ImageResponse,
  type Modality,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type Usage,
  type VideoRequest,
  type VideoResponse,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { fromDataUrl, httpJson, httpRequest, toDataUrl } from '../http.js';

/** Replicate caps a synchronous wait at 60 seconds and rejects anything longer. */
const PREFER_WAIT_MAX_SEC = 60;
/** The wait is measured server-side; leave room for the response to travel. */
const PREFER_WAIT_SLACK_MS = 10_000;
const POLL_INTERVAL_MS = 1_500;
/** A single poll must never eat the whole deadline; the loop owns the budget. */
const POLL_CALL_TIMEOUT_MS = 15_000;
const ASSET_FETCH_TIMEOUT_MS = 120_000;
const CANCEL_TIMEOUT_MS = 5_000;

/**
 * Replicate hosts tens of thousands of public models and pages them 25 at a
 * time, so a full crawl is neither finishable inside one request deadline nor
 * useful to a router. Discovery takes a bounded slice off the top.
 */
const MAX_DISCOVERED_MODELS = 100;
const MAX_DISCOVERY_PAGES = 8;

/** Version ids are sha256 hex; prediction ids and slugs never match this. */
const VERSION_HASH = /^[0-9a-f]{64}$/i;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

interface ReplicateModelRow {
  owner?: string;
  name?: string;
  description?: string | null;
  latest_version?: { id?: string } | null;
}

interface ReplicateModelPage {
  results?: ReplicateModelRow[];
  next?: string | null;
}

/**
 * Replicate's predictions API (https://replicate.com/docs/reference/http).
 *
 * Everything here is a prediction: create one against a model or a pinned
 * version, then wait for it to reach a terminal status. Two details shape the
 * adapter. `Prefer: wait` lets the create call itself block for up to a minute,
 * which retires the polling loop entirely for the many models that finish in
 * seconds — but it is best-effort, so the loop still has to exist. And `input`
 * is defined by each model's own Cog schema rather than by Replicate, so
 * nothing is sent that the caller did not ask for: an unrecognised key fails
 * validation instead of being politely ignored.
 *
 * Only the media surfaces are implemented. Replicate does host language models,
 * but they are reached as predictions with per-model input schemas and no
 * common chat shape, so there is no honest chat method to expose here.
 */
export class ReplicateAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private pricingLookup: (providerModelId: string) => Pricing | null = () => null;

  constructor(descriptor: ProviderDescriptor) {
    this.descriptor = descriptor;
  }

  setPricingLookup(fn: (providerModelId: string) => Pricing | null): void {
    this.pricingLookup = fn;
  }

  capabilities(): AdapterCapabilities {
    return {
      chat: false,
      streaming: false,
      tools: false,
      vision: false,
      embedding: false,
      image: true,
      video: true,
      speech: false,
      transcription: false,
      discovery: true,
      health: true,
    };
  }

  private baseUrl(ctx: AdapterContext): string {
    return (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
  }

  private headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    if (!ctx.secret) {
      throw new MeridianError('authentication_failed', 'Replicate requires an API token', {
        providerId: this.descriptor.id,
      });
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.secret}`,
      ...extra,
      ...ctx.headers,
    };
  }

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const deadline = Date.now() + ctx.timeoutMs;
    const out: ModelDescriptor[] = [];
    const base = this.baseUrl(ctx);
    let url: string | null = `${base}/models`;
    let pages = 0;

    // The crawl is a deliberately partial slice already, so running out of time
    // truncates it one page earlier rather than throwing away the models
    // already collected on a page request with a millisecond left to spend.
    while (url && pages < MAX_DISCOVERY_PAGES && out.length < MAX_DISCOVERED_MODELS && Date.now() < deadline) {
      const page: ReplicateModelPage = await httpJson<ReplicateModelPage>(url, {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: this.budget(deadline, POLL_CALL_TIMEOUT_MS),
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      for (const row of page.results ?? []) {
        const mapped = this.toModel(row);
        if (mapped) out.push(mapped);
        if (out.length >= MAX_DISCOVERED_MODELS) break;
      }
      url = typeof page.next === 'string' && page.next ? this.sameOrigin(page.next, base) : null;
      pages += 1;
    }
    return out;
  }

  private toModel(row: ReplicateModelRow): ModelDescriptor | null {
    const owner = row.owner;
    const name = row.name;
    if (!owner || !name) return null;
    const id = `${owner}/${name}`;

    // The listing carries no modality field, and routing image work to a video
    // model wastes a paid prediction on an unusable file. A model we cannot
    // place from its name and description is dropped rather than guessed at.
    const modality = inferModality(id, row.description ?? '');
    if (!modality) return null;

    const version = row.latest_version?.id;
    return {
      id: modelKey(this.descriptor.id, id),
      providerId: this.descriptor.id,
      providerModelId: id,
      displayName: id,
      // Publisher is the only grouping Replicate itself imposes on models.
      family: owner,
      modalities: [modality],
      capabilities: [modality === 'video' ? 'video-generation' : 'image-generation'],
      contextLength: null,
      maxOutputTokens: null,
      pricing: this.pricingLookup(id) ?? this.descriptor.defaultPricing,
      discovered: true,
      deprecated: false,
      // The version hash is what makes a run reproducible, so it is worth
      // surfacing even though calls default to whatever is latest.
      tags: version ? [`version:${version}`] : [],
      updatedAt: Date.now(),
    };
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      // /account proves the token works without creating a prediction, so a
      // liveness probe never bills GPU seconds.
      await httpRequest(`${this.baseUrl(ctx)}/account`, {
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

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    const started = Date.now();
    const deadline = started + ctx.timeoutMs;
    const model = this.requireModel(req.model, 'image generation');

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.width != null) input.width = req.width;
    if (req.height != null) input.height = req.height;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (req.steps != null) input.num_inference_steps = req.steps;
    if (req.guidance != null) input.guidance_scale = req.guidance;
    if (req.seed != null) input.seed = req.seed;
    // Omitted at n=1: one image is the default everywhere, and a model without
    // the field would reject the request rather than ignore it.
    if (req.n != null && req.n > 1) input.num_outputs = req.n;
    // Replicate accepts a data URI anywhere a model declares a file input.
    if (req.referenceImage) input.image = req.referenceImage;

    const done = await this.runPrediction(model, input, deadline, ctx);
    const assets = await this.fetchAssets(done.output, deadline, ctx, 'image/png', {
      width: req.width,
      height: req.height,
      seed: req.seed ?? null,
    });
    if (assets.length === 0) {
      throw new MeridianError('server_error', `Replicate prediction ${done.id ?? '?'} succeeded without a file output`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: { predictionId: done.id ?? null },
      });
    }

    return {
      id: newId('img'),
      model,
      providerId: this.descriptor.id,
      assets,
      latencyMs: Date.now() - started,
      usage: this.usage(model),
    };
  }

  async video(req: VideoRequest, ctx: AdapterContext): Promise<VideoResponse> {
    const started = Date.now();
    const deadline = started + ctx.timeoutMs;
    const model = this.requireModel(req.model, 'video generation');

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.width != null) input.width = req.width;
    if (req.height != null) input.height = req.height;
    if (req.fps != null) input.fps = req.fps;
    if (req.seed != null) input.seed = req.seed;
    if (req.referenceImage) input.image = req.referenceImage;
    // durationSec and motion are deliberately dropped: video models here spell
    // them half a dozen ways (num_frames, duration, video_length,
    // motion_bucket_id) with no field common enough to send blind, and one
    // unrecognised key fails the whole prediction.

    const done = await this.runPrediction(model, input, deadline, ctx);
    const assets = await this.fetchAssets(done.output, deadline, ctx, 'video/mp4', {
      width: req.width,
      height: req.height,
      seed: req.seed ?? null,
    });
    if (assets.length === 0) {
      throw new MeridianError('server_error', `Replicate prediction ${done.id ?? '?'} succeeded without a file output`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: { predictionId: done.id ?? null },
      });
    }

    return {
      id: newId('vid'),
      model,
      providerId: this.descriptor.id,
      assets,
      latencyMs: Date.now() - started,
      usage: this.usage(model),
      // This call only returns once the prediction reached a terminal status,
      // so there is no in-flight state left for the caller to observe.
      status: 'completed',
      progress: 1,
    };
  }

  private async runPrediction(
    model: string,
    input: Record<string, unknown>,
    deadline: number,
    ctx: AdapterContext,
  ): Promise<ReplicatePrediction> {
    const base = this.baseUrl(ctx);
    const { url, body } = this.endpointFor(base, model, input);

    // Sync mode: Replicate holds the create call open until the prediction
    // settles or the wait elapses, so a model that runs in five seconds costs
    // one round trip instead of a create plus a poll. It never promises a
    // finished prediction, which is why awaitPrediction still exists.
    const waitSec = Math.max(1, Math.min(PREFER_WAIT_MAX_SEC, Math.floor((deadline - Date.now()) / 1000)));
    const created = await httpJson<ReplicatePrediction>(url, {
      headers: this.headers(ctx, { prefer: `wait=${waitSec}` }),
      body,
      timeoutMs: this.budget(deadline, waitSec * 1000 + PREFER_WAIT_SLACK_MS),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
    return this.awaitPrediction(created, model, deadline, ctx);
  }

  /** Poll until the prediction succeeds, or fail with the reason it did not. */
  private async awaitPrediction(
    created: ReplicatePrediction,
    model: string,
    deadline: number,
    ctx: AdapterContext,
  ): Promise<ReplicatePrediction> {
    const id = created.id;
    if (!id) {
      throw new MeridianError('server_error', 'Replicate accepted the request without a prediction id', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }
    const base = this.baseUrl(ctx);
    // Replicate hands back the canonical URLs for this prediction; using them
    // keeps working if predictions ever move off the /predictions path. Both
    // the poll and the cancel carry the token, so a URL lifted out of a
    // response body is only honoured while it stays on the host we called.
    const getUrl = this.sameOrigin(created.urls?.get, base) ?? `${base}/predictions/${encodeURIComponent(id)}`;
    const cancelUrl =
      this.sameOrigin(created.urls?.cancel, base) ?? `${base}/predictions/${encodeURIComponent(id)}/cancel`;

    let current = created;
    try {
      for (;;) {
        if (current.status === 'succeeded') return current;
        if (current.status === 'failed') {
          throw new MeridianError('server_error', `Replicate prediction ${id} failed: ${current.error || 'no detail given'}`, {
            providerId: this.descriptor.id,
            modelId: model,
            details: { predictionId: id },
          });
        }
        if (current.status === 'canceled') {
          throw new MeridianError('cancelled', `Replicate prediction ${id} was canceled`, {
            providerId: this.descriptor.id,
            modelId: model,
            details: { predictionId: id },
          });
        }
        if (ctx.signal?.aborted) {
          throw new MeridianError('cancelled', `Replicate prediction ${id} cancelled`, {
            providerId: this.descriptor.id,
            modelId: model,
            details: { predictionId: id },
          });
        }
        if (Date.now() >= deadline) {
          throw new MeridianError(
            'timeout',
            `Replicate prediction ${id} did not finish within ${ctx.timeoutMs}ms (last status: ${current.status ?? 'unknown'})`,
            { providerId: this.descriptor.id, modelId: model, details: { predictionId: id } },
          );
        }

        // Never sleep past the deadline, and re-check before spending a call:
        // the sleep can consume the last of the budget, and a poll issued on
        // the remainder fails as an anonymous transport timeout. Looping back
        // instead reports the timeout above, which names the prediction and the
        // last status it was seen in.
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), ctx.signal);
        if (ctx.signal?.aborted || Date.now() >= deadline) continue;

        current = await httpJson<ReplicatePrediction>(getUrl, {
          method: 'GET',
          headers: this.headers(ctx),
          timeoutMs: this.budget(deadline, POLL_CALL_TIMEOUT_MS),
          signal: ctx.signal,
          providerId: this.descriptor.id,
          modelId: model,
        });
      }
    } catch (e) {
      // A prediction nobody is waiting for keeps burning billable compute until
      // it finishes on its own, so releasing it is worth one blind call.
      if (!TERMINAL_STATUSES.has(current.status ?? '')) await this.cancelPrediction(cancelUrl, ctx);
      throw e;
    }
  }

  /**
   * Best effort by construction: ctx.signal is usually the reason we are here,
   * so passing it along would abort the cancel too.
   */
  private async cancelPrediction(url: string, ctx: AdapterContext): Promise<void> {
    try {
      await httpRequest(url, {
        method: 'POST',
        headers: this.headers(ctx),
        timeoutMs: CANCEL_TIMEOUT_MS,
        providerId: this.descriptor.id,
      });
    } catch {
      /* The caller already has a real error to report; this one adds nothing. */
    }
  }

  /**
   * A bare version hash is created against /predictions, a slug against the
   * model's own endpoint so it always runs whatever version is current.
   */
  private endpointFor(
    base: string,
    model: string,
    input: Record<string, unknown>,
  ): { url: string; body: Record<string, unknown> } {
    const colon = model.lastIndexOf(':');
    const pinned = colon > 0 ? model.slice(colon + 1) : model;
    if (VERSION_HASH.test(pinned)) {
      // The hash is globally unique, so the owner/name half of an
      // "owner/name:hash" reference is decoration the API does not need.
      return { url: `${base}/predictions`, body: { version: pinned, input } };
    }
    const parts = model.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new MeridianError(
        'invalid_request',
        `"${model}" is not a Replicate model reference; expected "owner/name" or a 64-character version hash`,
        { providerId: this.descriptor.id, modelId: model },
      );
    }
    return {
      url: `${base}/models/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/predictions`,
      body: { input },
    };
  }

  private requireModel(model: string | undefined, surface: string): string {
    const trimmed = model?.trim();
    if (!trimmed) {
      // There is no house model to fall back on: every prediction names one.
      throw new MeridianError('invalid_request', `Replicate ${surface} requires a model reference`, {
        providerId: this.descriptor.id,
      });
    }
    return trimmed;
  }

  private async fetchAssets(
    output: unknown,
    deadline: number,
    ctx: AdapterContext,
    fallbackMime: string,
    shape: { width?: number; height?: number; seed: number | null },
  ): Promise<GeneratedAsset[]> {
    const assets: GeneratedAsset[] = [];
    for (const url of collectOutputUrls(output)) {
      let bytes: Uint8Array;
      let mimeType = fallbackMime;
      // A Cog server addressed directly through ctx.baseUrl inlines its file
      // outputs as data URIs rather than uploading them, so there is nothing
      // to fetch in that case.
      const inline = url.startsWith('data:') ? fromDataUrl(url) : null;
      if (inline) {
        bytes = inline.bytes;
        mimeType = inline.mimeType;
      } else {
        // Outputs are served from Replicate's delivery host, which needs no
        // credential — and the token must not follow a download off the API.
        const res = await httpRequest(url, {
          method: 'GET',
          timeoutMs: this.budget(deadline, ASSET_FETCH_TIMEOUT_MS),
          signal: ctx.signal,
          providerId: this.descriptor.id,
        });
        bytes = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get('content-type');
        if (contentType) mimeType = contentType.split(';')[0].trim();
      }
      if (bytes.byteLength === 0) continue;
      assets.push({ url: toDataUrl(bytes, mimeType), mimeType, ...shape, bytes: bytes.byteLength });
    }
    return assets;
  }

  /**
   * Replicate bills per second of GPU time on whichever hardware a model runs
   * on, and publishes no rate through the API — only `metrics.predict_time`,
   * after the fact. So the rates stay null unless an operator supplies their
   * own through the pricing lookup. The billable unit is the prediction rather
   * than the file: a four-image batch is still one run of the model.
   */
  private usage(model: string): Usage {
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, 0, 0, 1) };
  }

  /** Per-call timeout that can never outlive the overall deadline. */
  private budget(deadline: number, cap: number): number {
    return Math.max(1, Math.min(cap, deadline - Date.now()));
  }

  /**
   * Replicate answers with absolute follow-up URLs — the paging cursor, and
   * each prediction's own get and cancel links — and every one of them is
   * fetched with the API token attached. A URL in a response body is not a
   * redirect worth paying for with a credential, so it is only followed when it
   * lands on the host the call already went to. Returns null otherwise, letting
   * the caller fall back to a URL it built itself.
   */
  private sameOrigin(raw: string | undefined, base: string): string | null {
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.origin === new URL(base).origin ? url.toString() : null;
    } catch {
      return null;
    }
  }
}

/**
 * Prediction output is whatever the model's own schema declares: one file URL,
 * a list of them, or an object wrapping one. Anything else a model may return —
 * a caption, a score, a list of numbers — is not an asset and is skipped rather
 * than coerced into one.
 */
function collectOutputUrls(output: unknown): string[] {
  if (typeof output === 'string') return isFetchable(output) ? [output] : [];
  if (Array.isArray(output)) return output.flatMap((entry) => collectOutputUrls(entry));
  if (output && typeof output === 'object') {
    const url = (output as Record<string, unknown>).url;
    return typeof url === 'string' && isFetchable(url) ? [url] : [];
  }
  return [];
}

function isFetchable(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith('data:');
}

const VIDEO_HINTS = /video|animat|img2vid|image-to-video|text-to-video|motion|interpolat/i;
const IMAGE_HINTS = /image|photo|picture|diffusion|sdxl|flux|render|inpaint|upscal|img2img/i;

/**
 * Video is tested first on purpose: "image-to-video" is a video model, and
 * matching on "image" would file it under the wrong modality.
 */
function inferModality(id: string, description: string): Extract<Modality, 'image' | 'video'> | null {
  const haystack = `${id} ${description}`;
  if (VIDEO_HINTS.test(haystack)) return 'video';
  if (IMAGE_HINTS.test(haystack)) return 'image';
  return null;
}

/** Wakes early on abort, so a cancelled job is not held for a full interval. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });
}
