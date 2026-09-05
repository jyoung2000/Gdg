import {
  MeridianError,
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
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, toDataUrl } from '../http.js';

/**
 * '0000000000' is the horde's published anonymous key. It keeps the provider
 * usable with no credential at all, at the cost of sitting behind every
 * kudos-holding account in the queue — anonymous jobs are heavily
 * deprioritised and can wait minutes for a worker.
 */
const ANONYMOUS_KEY = '0000000000';

/** `name:version:contact`, the form the horde asks clients to identify with. */
const CLIENT_AGENT = 'meridian:1.0:unspecified';

const POLL_INTERVAL_MS = 2_000;
/** A single poll must never eat the whole deadline; the loop owns the budget. */
const POLL_CALL_TIMEOUT_MS = 15_000;
const IMAGE_FETCH_TIMEOUT_MS = 60_000;

/**
 * Generation on the horde is paid for in kudos, which are earned by donating
 * GPU time and buy queue priority rather than access. No amount of money
 * changes hands, so there is no USD rate to report.
 */
const HORDE_PRICING: Pricing = {
  kind: 'FREE',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: 'Crowdsourced volunteer workers; kudos buy queue priority, not access',
};

interface HordeAsyncResponse {
  id?: string;
  message?: string;
}

interface HordeCheckResponse {
  done?: boolean;
  finished?: number;
  processing?: number;
  waiting?: number;
  wait_time?: number;
  faulted?: boolean;
}

interface HordeGeneration {
  img?: string;
  seed?: string;
  model?: string;
}

interface HordeStatusResponse {
  generations?: HordeGeneration[];
  faulted?: boolean;
  done?: boolean;
}

interface HordeModelStatus {
  name?: string;
  count?: number;
  performance?: number;
}

/**
 * AI Horde, the crowdsourced image cluster, over its v2 REST API
 * (https://stablehorde.net/api/v2).
 *
 * Two things shape this adapter. Generation is asynchronous — a job is queued
 * against a pool of volunteer GPUs and picked up whenever one frees up — so a
 * single `image()` call is a submit, a polling loop and a fetch of the finished
 * asset, all inside one deadline. And the cluster is genuinely image-only:
 * there is no chat, embedding or audio surface here to implement.
 */
export class AIHordeAdapter implements ProviderAdapter {
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
      video: false,
      speech: false,
      transcription: false,
      discovery: true,
      health: true,
    };
  }

  private baseUrl(ctx: AdapterContext): string {
    return (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
  }

  private headers(ctx: AdapterContext): Record<string, string> {
    return {
      'content-type': 'application/json',
      // Truthiness, not ??: a blank credential would otherwise be sent as an
      // empty apikey and come back as a 401 the operator cannot act on.
      apikey: ctx.secret || ANONYMOUS_KEY,
      'client-agent': CLIENT_AGENT,
      ...ctx.headers,
    };
  }

  /* -------------------------------------------------------------- */
  /* Discovery and health                                            */
  /* -------------------------------------------------------------- */

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const raw = await httpJson<HordeModelStatus[]>(`${this.baseUrl(ctx)}/status/models?type=image`, {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
    });
    const rows = Array.isArray(raw) ? raw : [];
    const out: ModelDescriptor[] = [];
    for (const row of rows) {
      const name = row.name;
      const workers = typeof row.count === 'number' ? row.count : 0;
      // Model availability on the horde is worker availability: a name with
      // nobody serving it queues forever, so it is not a routable model.
      if (!name || workers <= 0) continue;
      out.push({
        id: modelKey(this.descriptor.id, name),
        providerId: this.descriptor.id,
        providerModelId: name,
        displayName: name,
        // Model names are declared by whoever runs the worker; there is no
        // consistent family taxonomy to derive one from.
        family: null,
        modalities: ['image'],
        capabilities: ['image-generation'],
        contextLength: null,
        maxOutputTokens: null,
        pricing: this.pricingLookup(name) ?? HORDE_PRICING,
        discovered: true,
        deprecated: false,
        tags: [`workers:${workers}`],
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      // The model-status listing needs no credential and consumes no kudos, so
      // a liveness probe never queues a job or spends a caller's queue priority.
      await httpRequest(`${this.baseUrl(ctx)}/status/models?type=image`, {
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

  /* -------------------------------------------------------------- */
  /* Image generation                                                */
  /* -------------------------------------------------------------- */

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    if (req.referenceImage) {
      // The body submitted below carries no source image, so accepting the
      // reference and dropping it would return an unrelated text-to-image
      // picture while the caller believed it was img2img.
      throw new MeridianError('unsupported_capability', 'AI Horde jobs are submitted as text-to-image only', {
        providerId: this.descriptor.id,
        modelId: req.model ?? null,
      });
    }
    const started = Date.now();
    const deadline = started + ctx.timeoutMs;
    const base = this.baseUrl(ctx);
    const model = req.model ?? '';
    const size = { width: snapDimension(req.width, 512), height: snapDimension(req.height, 512) };

    const submitted = await httpJson<HordeAsyncResponse>(`${base}/generate/async`, {
      headers: this.headers(ctx),
      body: this.generateBody(req, size),
      timeoutMs: this.budget(deadline, ctx.timeoutMs),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model || null,
    });
    const jobId = submitted.id;
    if (!jobId) {
      throw new MeridianError('server_error', `AI Horde accepted the request without a job id: ${submitted.message ?? 'no detail'}`, {
        providerId: this.descriptor.id,
        modelId: model || null,
      });
    }

    let status: HordeStatusResponse;
    try {
      status = await this.awaitJob(base, jobId, deadline, ctx, model);
    } catch (e) {
      // A job we have stopped waiting for still occupies a volunteer worker
      // until it finishes, so releasing it is worth one best-effort call.
      await this.cancelJob(base, jobId, ctx);
      throw e;
    }

    const generations = status.generations ?? [];
    const assets: GeneratedAsset[] = [];
    for (const gen of generations) {
      const asset = await this.toAsset(gen, size, deadline, ctx);
      if (asset) assets.push(asset);
    }
    if (assets.length === 0) {
      throw new MeridianError('server_error', `AI Horde job ${jobId} completed with no usable image`, {
        providerId: this.descriptor.id,
        modelId: model || null,
        details: { jobId, generations: generations.length },
      });
    }

    // Unpinned requests are served by whichever worker takes the job, so the
    // model that actually ran is the only honest thing to report back.
    const servedModel = generations.find((g) => g.model)?.model ?? model;
    const pricing = this.pricingLookup(servedModel) ?? HORDE_PRICING;
    return {
      id: newId('img'),
      model: servedModel,
      providerId: this.descriptor.id,
      assets,
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, 0, 0, assets.length) },
    };
  }

  private generateBody(req: ImageRequest, size: { width: number; height: number }): Record<string, unknown> {
    const params: Record<string, unknown> = {
      width: size.width,
      height: size.height,
      steps: req.steps ?? 30,
      cfg_scale: req.guidance ?? 7.5,
      n: req.n ?? 1,
      sampler_name: 'k_euler_a',
    };
    // The horde types the seed as a string; workers accept arbitrary text and
    // hash it, so a number has to be stringified rather than sent raw.
    if (req.seed != null) params.seed = String(req.seed);

    const body: Record<string, unknown> = {
      // There is no negative-prompt field: the horde splits the prompt on '###'
      // and hands the tail to the worker as the negative.
      prompt: req.negativePrompt ? `${req.prompt} ### ${req.negativePrompt}` : req.prompt,
      params,
      nsfw: false,
      // r2 returns a download URL instead of inlining megabytes of base64 in
      // the status response.
      r2: true,
    };
    // Pinning a model with no workers online queues indefinitely, so a request
    // that named no model is left open to the whole cluster.
    if (req.model) body.models = [req.model];
    return body;
  }

  /** Poll until the job is done, then read its result. */
  private async awaitJob(
    base: string,
    jobId: string,
    deadline: number,
    ctx: AdapterContext,
    model: string,
  ): Promise<HordeStatusResponse> {
    let queueEta: number | null = null;

    for (;;) {
      if (ctx.signal?.aborted) {
        throw new MeridianError('cancelled', 'Image generation cancelled', {
          providerId: this.descriptor.id,
          modelId: model || null,
          details: { jobId },
        });
      }
      if (Date.now() >= deadline) {
        const eta = queueEta != null ? `; horde last estimated ${queueEta}s of queue` : '';
        throw new MeridianError('timeout', `AI Horde job ${jobId} did not finish within ${ctx.timeoutMs}ms${eta}`, {
          providerId: this.descriptor.id,
          modelId: model || null,
          details: { jobId },
        });
      }

      const check = await httpJson<HordeCheckResponse>(`${base}/generate/check/${jobId}`, {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: this.budget(deadline, POLL_CALL_TIMEOUT_MS),
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model || null,
      });
      if (check.faulted) {
        throw new MeridianError('server_error', `AI Horde job ${jobId} faulted before any worker could finish it`, {
          providerId: this.descriptor.id,
          modelId: model || null,
          details: { jobId, waiting: check.waiting ?? null, processing: check.processing ?? null },
        });
      }
      if (typeof check.wait_time === 'number') queueEta = check.wait_time;
      if (check.done) break;

      await sleep(POLL_INTERVAL_MS, ctx.signal);
    }

    const status = await httpJson<HordeStatusResponse>(`${base}/generate/status/${jobId}`, {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: this.budget(deadline, POLL_CALL_TIMEOUT_MS),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model || null,
    });
    // `done` can flip while individual generations still fail on their worker.
    if (status.faulted) {
      throw new MeridianError('server_error', `AI Horde job ${jobId} faulted while generating`, {
        providerId: this.descriptor.id,
        modelId: model || null,
        details: { jobId },
      });
    }
    return status;
  }

  private async toAsset(
    gen: HordeGeneration,
    size: { width: number; height: number },
    deadline: number,
    ctx: AdapterContext,
  ): Promise<GeneratedAsset | null> {
    const img = gen.img;
    if (!img) return null;

    let bytes: Uint8Array;
    let mimeType = 'image/webp';
    if (/^https?:/i.test(img)) {
      // With r2 on, the image lives in the horde's object store on another
      // host. It takes no credential, and the apikey must not follow the
      // download off the API — so this call carries no auth headers at all.
      const res = await httpRequest(img, {
        method: 'GET',
        timeoutMs: this.budget(deadline, IMAGE_FETCH_TIMEOUT_MS),
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      bytes = new Uint8Array(await res.arrayBuffer());
      const contentType = res.headers.get('content-type');
      if (contentType) mimeType = contentType.split(';')[0].trim();
    } else {
      // Workers that cannot upload fall back to inlining the webp as base64.
      bytes = new Uint8Array(Buffer.from(img, 'base64'));
    }
    if (bytes.byteLength === 0) return null;

    const seed = gen.seed != null ? Number.parseInt(gen.seed, 10) : Number.NaN;
    return {
      url: toDataUrl(bytes, mimeType),
      mimeType,
      width: size.width,
      height: size.height,
      seed: Number.isFinite(seed) ? seed : null,
      bytes: bytes.byteLength,
    };
  }

  /**
   * Best effort by construction: the caller is already gone, and ctx.signal is
   * typically the reason we are here, so passing it would abort this call too.
   */
  private async cancelJob(base: string, jobId: string, ctx: AdapterContext): Promise<void> {
    try {
      await httpRequest(`${base}/generate/status/${jobId}`, {
        method: 'DELETE',
        headers: this.headers(ctx),
        timeoutMs: 5_000,
        providerId: this.descriptor.id,
      });
    } catch {
      /* The horde expires abandoned jobs on its own; nothing to escalate. */
    }
  }

  /** Per-call timeout that can never outlive the overall deadline. */
  private budget(deadline: number, cap: number): number {
    return Math.max(1, Math.min(cap, deadline - Date.now()));
  }
}

/* ------------------------------------------------------------------ */

/**
 * The horde rejects dimensions that are not multiples of 64, and anything past
 * 1024 needs the kudos of a funded account — which the anonymous key does not
 * have. Snapping is friendlier than a rejected job the caller cannot fix.
 */
function snapDimension(value: number | undefined, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(1024, Math.max(64, Math.round(raw / 64) * 64));
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
