import {
  MeridianError,
  computeCost,
  isMeridianError,
  newId,
  type ErrorCode,
  type GeneratedAsset,
  type ImageRequest,
  type ImageResponse,
  type Pricing,
  type ProviderDescriptor,
  type VideoRequest,
  type VideoResponse,
} from '@meridian/shared';
import type { AdapterSurface, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, toDataUrl } from '../http.js';

/**
 * Video jobs routinely run for minutes, so a fixed one-second poll would spend
 * hundreds of status calls learning nothing. The interval starts tight enough
 * that a fast image still returns promptly, then backs off once the job has
 * shown it is not instant.
 */
const POLL_MIN_INTERVAL_MS = 1_000;
const POLL_MAX_INTERVAL_MS = 5_000;
const POLL_BACKOFF = 1.5;

/** A single queue call must never eat the whole deadline; the loop owns it. */
const QUEUE_CALL_TIMEOUT_MS = 15_000;
/** Finished video files are large, so the download gets its own wider cap. */
const ASSET_FETCH_TIMEOUT_MS = 120_000;

/**
 * fal bills per generation at a rate that differs for every model and is
 * published only on that model's own page — there is no rate endpoint to read
 * it from. So `perRequest` stays null unless the operator's pricing catalog
 * supplies a real figure, and a reported cost of zero here means "not known",
 * never "free": fal has no free tier at all.
 */
const FAL_PRICING: Pricing = {
  kind: 'METERED',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: 'Pay-per-use. Per-model rates are published on fal.ai and are not exposed by any API.',
};

/**
 * Model ids are path segments on the queue host — `fal-ai/flux/dev` — and get
 * concatenated into a URL that carries the credential. Anything outside the
 * character set fal actually uses could steer that request, and its
 * Authorization header, at another host or path.
 */
const MODEL_PATH = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

/**
 * fal's video apps take an aspect ratio from a short published enumeration
 * rather than a pixel size, so a request's dimensions are matched to the
 * nearest entry and dropped when nothing is close, rather than sent and
 * rejected.
 */
const KNOWN_ASPECT_RATIOS: readonly (readonly [string, number])[] = [
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['21:9', 21 / 9],
];

/**
 * The frame sizes callers actually ask for are rounded to whatever the model
 * likes — 1344x768 for 16:9, 1152x896 for 4:3 — so exact integer reduction
 * matches almost nothing. This is the widest miss still worth calling the same
 * shape; past it, sending an enum would reframe the shot the caller asked for.
 */
const ASPECT_TOLERANCE = 0.05;

/**
 * Errors that still prove the queue answered us. A bare GET on the queue root
 * is not a routable request, so fal rejecting its shape is the healthy
 * outcome; only a refused credential or a dead transport is a real failure.
 */
const PROBE_OK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['model_unavailable', 'invalid_request']);

interface FalQueueSubmission {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalQueueStatus {
  status?: string;
  queue_position?: number;
}

interface FalImageOutput {
  images?: { url?: string; width?: number; height?: number; content_type?: string }[];
  seed?: number;
}

interface FalVideoOutput {
  video?: { url?: string; content_type?: string };
}

/**
 * fal.ai over its queue API (https://queue.fal.run).
 *
 * Every model on fal is an application with its own input schema, reached at
 * its own path, and every generation goes through the same three steps:
 * submit, poll, collect. That shape — not the modality — is what this adapter
 * implements, so image and video differ only in the input they build and the
 * output they read back.
 *
 * There is no chat, embedding or audio surface here, and no discovery: fal
 * publishes its catalog as a website, not as an API, so the models it can be
 * routed come from Meridian's own catalog rather than from the provider.
 */
export class FalAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private pricingLookup: (providerModelId: string) => Pricing | null = () => null;

  constructor(descriptor: ProviderDescriptor) {
    this.descriptor = descriptor;
  }

  setPricingLookup(fn: (providerModelId: string) => Pricing | null): void {
    this.pricingLookup = fn;
  }

  surface(): AdapterSurface {
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
      discovery: false,
      health: true,
    };
  }

  private baseUrl(ctx: AdapterContext): string {
    return (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
  }

  private headers(ctx: AdapterContext): Record<string, string> {
    if (!ctx.secret) {
      throw new MeridianError('authentication_failed', 'fal.ai requires an API key', { providerId: this.descriptor.id });
    }
    return {
      'content-type': 'application/json',
      // fal's own scheme. The token is prefixed with `Key`, not `Bearer`, and
      // a Bearer prefix is rejected.
      authorization: `Key ${ctx.secret}`,
      ...ctx.headers,
    };
  }

  private pricingFor(model: string): Pricing {
    return this.pricingLookup(model) ?? FAL_PRICING;
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      // fal publishes neither a model listing nor a key-verification endpoint,
      // and every generation route costs money, so the queue host itself is the
      // only free probe available. It proves reachability and a well-formed
      // credential; a key without access to a specific model only surfaces on
      // the first real submission.
      await httpRequest(this.baseUrl(ctx), {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: Math.min(ctx.timeoutMs, 15_000),
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      const latencyMs = Date.now() - started;
      if (isMeridianError(e) && PROBE_OK_CODES.has(e.code)) return { ok: true, latencyMs };
      return { ok: false, latencyMs, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    const started = Date.now();
    const deadline = started + ctx.timeoutMs;
    const model = this.requireModel(req.model);

    const output = await this.runQueueJob<FalImageOutput>(model, imageInput(req), ctx, deadline);
    const images = output.images ?? [];
    const assets: GeneratedAsset[] = [];
    for (const image of images) {
      const asset = await this.fetchAsset(image.url, image.content_type, ctx, deadline);
      if (!asset) continue;
      assets.push({
        ...asset,
        width: image.width ?? req.width,
        height: image.height ?? req.height,
        // fal echoes the seed it actually used, which is the only way to learn
        // it when the caller left the choice to the model.
        seed: typeof output.seed === 'number' ? output.seed : (req.seed ?? null),
      });
    }
    if (assets.length === 0) {
      throw new MeridianError('server_error', `fal model ${model} completed with no usable image`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: { images: images.length },
      });
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

  async video(req: VideoRequest, ctx: AdapterContext): Promise<VideoResponse> {
    const started = Date.now();
    const deadline = started + ctx.timeoutMs;
    const model = this.requireModel(req.model);

    const output = await this.runQueueJob<FalVideoOutput>(model, videoInput(req), ctx, deadline);
    const asset = await this.fetchAsset(output.video?.url, output.video?.content_type, ctx, deadline);
    if (!asset) {
      throw new MeridianError('server_error', `fal model ${model} completed with no usable video`, {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }

    return {
      id: newId('vid'),
      model,
      providerId: this.descriptor.id,
      // fal reports no measured duration, and echoing the requested one back as
      // a fact about the file would be a guess.
      assets: [asset],
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(this.pricingFor(model), 0, 0, 1) },
      // The queue is driven to completion inside this call, so the intermediate
      // states are never observable from outside it.
      status: 'completed',
      progress: 1,
    };
  }

  /**
   * Submit, poll to completion, collect. Both media surfaces share this: on fal
   * the difference between an image model and a video model is the JSON on
   * either end, not the protocol in between.
   */
  private async runQueueJob<T>(
    model: string,
    input: Record<string, unknown>,
    ctx: AdapterContext,
    deadline: number,
  ): Promise<T> {
    const base = this.baseUrl(ctx);
    const origin = this.queueOrigin(base);

    const submission = await httpJson<FalQueueSubmission>(`${base}/${model}`, {
      headers: this.headers(ctx),
      body: input,
      timeoutMs: this.budget(deadline, ctx.timeoutMs),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
    const statusUrl = this.queueUrl(submission.status_url, origin, 'status_url', model);
    const responseUrl = this.queueUrl(submission.response_url, origin, 'response_url', model);

    await this.awaitCompletion(statusUrl, submission.request_id ?? null, model, ctx, deadline);

    return await httpJson<T>(responseUrl, {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: this.budget(deadline, QUEUE_CALL_TIMEOUT_MS),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
  }

  /**
   * Ask fal's queue to stop a request we no longer want.
   *
   * The queue exposes `PUT .../requests/{id}/cancel` beside the status URL.
   * Failures are swallowed on purpose: this runs on the way out of a cancel or
   * timeout, and the caller's error is the one that matters.
   */
  private async cancelQueued(statusUrl: string, ctx: AdapterContext): Promise<void> {
    const cancelUrl = statusUrl.replace(/\/status\/?$/, '/cancel');
    if (cancelUrl === statusUrl) return;
    try {
      await httpRequest(cancelUrl, {
        method: 'PUT',
        headers: this.headers(ctx),
        timeoutMs: 10_000,
        providerId: this.descriptor.id,
      });
    } catch {
      /* best-effort; the job may already be past cancellation */
    }
  }

  private async awaitCompletion(
    statusUrl: string,
    requestId: string | null,
    model: string,
    ctx: AdapterContext,
    deadline: number,
  ): Promise<void> {
    let interval = POLL_MIN_INTERVAL_MS;
    let queuePosition: number | null = null;

    for (;;) {
      if (ctx.signal?.aborted) {
        // Walking away locally is not enough: the queue keeps rendering, and on
        // a paid account that is GPU time billed for output nobody will fetch.
        // Cancellation is best-effort — the job may already be running past the
        // point fal will stop it — but not asking guarantees the waste.
        await this.cancelQueued(statusUrl, ctx);
        throw new MeridianError('cancelled', `fal job ${requestId ?? 'unknown'} cancelled`, {
          providerId: this.descriptor.id,
          modelId: model,
          details: { requestId },
        });
      }
      if (Date.now() >= deadline) {
        await this.cancelQueued(statusUrl, ctx);
        const queued = queuePosition != null ? `; last reported queue position ${queuePosition}` : '';
        throw new MeridianError('timeout', `fal job ${requestId ?? 'unknown'} did not finish within ${ctx.timeoutMs}ms${queued}`, {
          providerId: this.descriptor.id,
          modelId: model,
          details: { requestId, queuePosition },
        });
      }

      const status = await httpJson<FalQueueStatus>(statusUrl, {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: this.budget(deadline, QUEUE_CALL_TIMEOUT_MS),
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      });
      if (typeof status.queue_position === 'number') queuePosition = status.queue_position;
      // COMPLETED is the only terminal value fal publishes here: a job that
      // fails ends as a non-2xx on this endpoint, which httpJson has already
      // classified. Everything else — IN_QUEUE, IN_PROGRESS, anything fal adds
      // later — means the same thing to us, which is "not yet".
      if (status.status === 'COMPLETED') return;

      // Never sleep past the deadline; the next iteration must be the one that
      // reports the timeout rather than a stale poll after it.
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), ctx.signal);
      interval = Math.min(POLL_MAX_INTERVAL_MS, Math.round(interval * POLL_BACKOFF));
    }
  }

  /**
   * fal serves finished assets from a public CDN on expiring links, so handing
   * one to a client would hand out a URL the gateway cannot keep alive. The
   * bytes come back through here and leave as a data: URL instead. The
   * credential stays on the API host: the CDN neither wants it nor should see
   * it, which is why this call sends no auth headers.
   */
  private async fetchAsset(
    url: string | undefined,
    declaredType: string | undefined,
    ctx: AdapterContext,
    deadline: number,
  ): Promise<GeneratedAsset | null> {
    if (!url) return null;
    // The address is whatever the model's own output JSON claimed, and this
    // call follows it unauthenticated on the gateway's network. fal serves
    // finished assets over http(s) and nothing else, so any other scheme is a
    // malformed or hostile output rather than a download worth attempting.
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await httpRequest(url, {
      method: 'GET',
      timeoutMs: this.budget(deadline, ASSET_FETCH_TIMEOUT_MS),
      signal: ctx.signal,
      providerId: this.descriptor.id,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const served = res.headers.get('content-type')?.split(';')[0].trim();
    const mimeType = served || declaredType || 'application/octet-stream';
    return { url: toDataUrl(bytes, mimeType), mimeType, bytes: bytes.byteLength };
  }

  private requireModel(model: string | undefined): string {
    const id = (model ?? '').trim();
    if (!id) {
      throw new MeridianError('invalid_request', 'fal routes by model path, e.g. "fal-ai/flux/dev"; it has no default model', {
        providerId: this.descriptor.id,
      });
    }
    if (!MODEL_PATH.test(id)) {
      throw new MeridianError('invalid_request', `"${id}" is not a fal model path`, {
        providerId: this.descriptor.id,
        modelId: id,
      });
    }
    return id;
  }

  private queueOrigin(base: string): string {
    try {
      return new URL(base).origin;
    } catch {
      throw new MeridianError('internal', `fal base URL "${base}" is not absolute`, { providerId: this.descriptor.id });
    }
  }

  /**
   * The queue hands back absolute follow-up URLs and every one of them is
   * fetched with the API key attached, so they are only followed when they land
   * on the host we submitted to. A URL in a response body is not a redirect
   * worth paying for with a credential.
   */
  private queueUrl(raw: string | undefined, origin: string, field: string, model: string): string {
    if (!raw) {
      throw new MeridianError('server_error', `fal accepted the job without a ${field}`, {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new MeridianError('server_error', `fal returned a malformed ${field}`, {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }
    if (url.origin !== origin) {
      throw new MeridianError('server_error', `fal returned a ${field} pointing at an unexpected host`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: { host: url.host },
      });
    }
    return url.toString();
  }

  /** Per-call timeout that can never outlive the overall deadline. */
  private budget(deadline: number, cap: number): number {
    return Math.max(1, Math.min(cap, deadline - Date.now()));
  }
}

function imageInput(req: ImageRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
  // image_size takes either one of fal's named presets or an explicit pair.
  // The pair is the only form derivable from arbitrary dimensions, and leaving
  // the field out entirely lets the model apply its own default rather than
  // forcing a size it may not support.
  if (req.width && req.height) input.image_size = { width: req.width, height: req.height };
  // Null-checked rather than undefined-checked: these arrive from a JSON body
  // that carries an explicit null for "unset", and forwarding one fails the
  // app's input validation instead of falling back to the model's default.
  if (req.steps != null) input.num_inference_steps = req.steps;
  if (req.guidance != null) input.guidance_scale = req.guidance;
  if (req.seed != null) input.seed = req.seed;
  if (req.n != null) input.num_images = req.n;
  // req.referenceImage is deliberately not forwarded: image-to-image is a
  // separate app on fal with a per-model input field, so guessing a name here
  // would quietly return a plain text-to-image result instead of failing.
  return input;
}

function videoInput(req: VideoRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt };
  // The image-to-video apps accept a data: URL for image_url, which is exactly
  // how the rest of Meridian carries a reference image, so it passes straight
  // through without a round trip to object storage.
  if (req.referenceImage) input.image_url = req.referenceImage;
  if (req.durationSec != null) input.duration = req.durationSec;
  const ratio = aspectRatio(req.width, req.height);
  if (ratio) input.aspect_ratio = ratio;
  // negativePrompt, seed and fps are deliberately not forwarded: fal's video
  // apps name these differently from app to app when they take them at all, so
  // a guessed key would change nothing while the caller believes it was
  // honoured — a silent wrong generation rather than a visible rejection.
  return input;
}

function aspectRatio(width: number | undefined, height: number | undefined): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const target = width / height;
  let best: string | null = null;
  let bestError = Number.POSITIVE_INFINITY;
  for (const [label, value] of KNOWN_ASPECT_RATIOS) {
    const error = Math.abs(value - target) / value;
    if (error < bestError) {
      bestError = error;
      best = label;
    }
  }
  return bestError <= ASPECT_TOLERANCE ? best : null;
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
