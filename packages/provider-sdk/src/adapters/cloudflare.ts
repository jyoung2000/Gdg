import {
  MeridianError,
  computeCost,
  newId,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type ErrorCode,
  type ImageRequest,
  type ImageResponse,
  type Pricing,
  type ProviderDescriptor,
  type StreamChunk,
  type Usage,
} from '@meridian/shared';
import type { AdapterSurface, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, sseLines, toDataUrl } from '../http.js';

/**
 * Where the account id may arrive when the base URL does not already carry it.
 * It is a path parameter for Workers AI, not an HTTP header, so it is consumed
 * here and never forwarded to Cloudflare.
 */
const ACCOUNT_ID_HEADER = 'x-meridian-account-id';

/** Every Cloudflare v4 response is wrapped in this envelope, success or not. */
interface CloudflareEnvelope<T> {
  result?: T | null;
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

interface WorkersTextResult {
  response?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface WorkersImageResult {
  image?: string;
}

/**
 * Workers AI bills in "neurons" against an allowance that resets daily, so no
 * per-token rate can be quoted honestly. Pinned here rather than read from the
 * descriptor default so a mis-filled catalog entry cannot make this look like
 * an unmetered free tier — the allowance runs out.
 */
const NEURON_PRICING: Pricing = {
  kind: 'FREE_DAILY',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  freeQuota: null,
  note: 'Cloudflare includes a daily neuron allowance on every account; usage beyond the allowance is billed per neuron.',
};

/**
 * Cloudflare Workers AI, via the REST run endpoint:
 * `POST /client/v4/accounts/{account_id}/ai/run/{model}`.
 *
 * Two things make it unlike the other hosted providers. First, the model is a
 * path segment and the call is account-scoped, so a token alone is not enough
 * to address the API — see {@link CloudflareWorkersAIAdapter.accountBase}.
 * Second, every response is wrapped in the Cloudflare v4 envelope, which can
 * report failure with a 200 status, so the envelope is checked on every call
 * rather than trusting the HTTP status alone.
 *
 * Tools and vision are not declared: both exist on a minority of Workers AI
 * models with per-model request shapes, and advertising them provider-wide
 * would route work here that most of the catalog cannot honour. There is no
 * `listModels` either — Workers AI publishes no stable model listing reachable
 * with an inference token, so its models come from the static catalog.
 */
export class CloudflareWorkersAIAdapter implements ProviderAdapter {
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
      chat: true,
      streaming: true,
      tools: false,
      vision: false,
      embedding: false,
      image: true,
      video: false,
      speech: false,
      transcription: false,
      discovery: false,
      health: true,
    };
  }

  /**
   * Resolve the account-scoped `/ai` root.
   *
   * The account id is not derivable from the API token, so it has to come from
   * the operator: either baked into the provider's base URL, or passed per call
   * as the `x-meridian-account-id` header (which is where a `CLOUDFLARE_ACCOUNT_ID`
   * environment value lands). A base URL carrying an unsubstituted placeholder
   * such as `/accounts/{account_id}` counts as "not supplied", because sending
   * it would produce a confusing 404 instead of a fixable configuration error.
   */
  private accountBase(ctx: AdapterContext): string {
    const raw = (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '').replace(/\/run$/, '');
    const inUrl = /\/accounts\/([^/]+)/.exec(raw);
    if (inUrl && !isPlaceholder(inUrl[1])) return withAiSuffix(raw);

    const accountId = this.accountId(ctx);
    if (!accountId) {
      throw new MeridianError(
        'invalid_request',
        'Cloudflare Workers AI needs an account id as well as an API token. Set the provider base URL to ' +
          'https://api.cloudflare.com/client/v4/accounts/<account id>/ai, or pass the id in the ' +
          `${ACCOUNT_ID_HEADER} header. The API token is not the account id.`,
        { providerId: this.descriptor.id },
      );
    }
    return withAiSuffix(inUrl ? raw.replace(/\/accounts\/[^/]+/, `/accounts/${accountId}`) : `${raw}/accounts/${accountId}`);
  }

  private accountId(ctx: AdapterContext): string | null {
    for (const [key, value] of Object.entries(ctx.headers ?? {})) {
      if (key.toLowerCase() === ACCOUNT_ID_HEADER && value.trim()) return value.trim();
    }
    return null;
  }

  private runUrl(ctx: AdapterContext, model: string): string {
    return `${this.accountBase(ctx)}/run/${model}`;
  }

  /** The v4 API root, for endpoints that live outside the account subtree. */
  private apiRoot(ctx: AdapterContext): string {
    const raw = (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
    const idx = raw.indexOf('/accounts/');
    return idx === -1 ? raw : raw.slice(0, idx);
  }

  private headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    if (!ctx.secret) {
      throw new MeridianError('authentication_failed', 'Cloudflare Workers AI requires an API token', {
        providerId: this.descriptor.id,
      });
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.secret}`,
      ...extra,
      // `x-meridian-*` entries are internal routing metadata; the account id in
      // particular has already been spent on the URL and must not be echoed on.
      ...forwardableHeaders(ctx.headers),
    };
  }

  /**
   * Verifying the token costs no neurons, which a Workers AI inference call
   * would. It does not exercise the account path, so a missing account id is
   * surfaced separately rather than being reported as a healthy provider.
   */
  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      this.accountBase(ctx);
      await httpRequest(`${this.apiRoot(ctx)}/user/tokens/verify`, {
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

  private body(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: req.messages.map((m) => toWorkersMessage(m)),
      stream,
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.extra) Object.assign(body, req.extra);
    return body;
  }

  async chat(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse> {
    const started = Date.now();
    const json = await httpJson<CloudflareEnvelope<WorkersTextResult>>(this.runUrl(ctx, req.model), {
      headers: this.headers(ctx),
      body: this.body(req, false),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });
    const result = this.unwrap(json, req.model);
    return {
      id: newId('cmpl'),
      model: req.model,
      providerId: this.descriptor.id,
      content: result.response ?? '',
      toolCalls: [],
      // Workers AI reports no stop reason, and a length-truncated answer looks
      // exactly like a completed one, so nothing stronger than 'stop' is honest.
      finishReason: 'stop',
      usage: this.usage(req.model, result.usage),
      latencyMs: Date.now() - started,
      ttftMs: null,
      viaFallback: false,
    };
  }

  async *chatStream(req: CompletionRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const res = await httpRequest(this.runUrl(ctx, req.model), {
      headers: this.headers(ctx, { accept: 'text/event-stream' }),
      body: this.body(req, true),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });

    // A run Cloudflare rejects answers with the v4 envelope under a 200 rather
    // than an event stream, and a model that ignores `stream` answers with the
    // whole completion. Read as a stream, both look like a successful response
    // that happened to carry no frames, so the caller would see an empty answer
    // instead of the provider's error.
    if ((res.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
      const result = this.unwrap((await res.json()) as CloudflareEnvelope<WorkersTextResult>, req.model);
      yield { type: 'start', model: req.model, providerId: this.descriptor.id };
      if (result.response) yield { type: 'text', delta: result.response };
      if (result.usage) yield { type: 'usage', usage: this.usage(req.model, result.usage) };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    yield { type: 'start', model: req.model, providerId: this.descriptor.id };

    let usage: WorkersTextResult['usage'] | null = null;
    for await (const data of sseLines(res, { signal: ctx.signal, idleTimeoutMs: ctx.streamIdleTimeoutMs, providerId: this.descriptor.id })) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue; // Keep-alives and malformed frames are not worth failing over.
      }
      // Frames carry the token in `response`; models served through the
      // OpenAI-compatible surface use the `choices[].delta.content` shape.
      const delta = typeof evt.response === 'string' ? evt.response : deltaContent(evt);
      if (delta) yield { type: 'text', delta };
      if (evt.usage && typeof evt.usage === 'object') usage = evt.usage as WorkersTextResult['usage'];
    }

    // Only the newer text models append a usage frame. Emitting a zeroed usage
    // for the rest would report fabricated token counts to the accounting layer.
    if (usage) yield { type: 'usage', usage: this.usage(req.model, usage) };
    yield { type: 'done', finishReason: 'stop' };
  }

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    const model = req.model;
    if (!model) {
      throw new MeridianError('invalid_request', 'Cloudflare Workers AI addresses the model in the URL, so one must be given', {
        providerId: this.descriptor.id,
      });
    }
    if (req.referenceImage) {
      // img2img is a different Workers AI request shape served by only part of
      // the catalog. Accepting the reference and then dropping it would answer
      // with a picture that has nothing to do with it.
      throw new MeridianError('unsupported_capability', 'Cloudflare Workers AI text-to-image takes no reference image', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }
    const started = Date.now();
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.width) body.width = req.width;
    if (req.height) body.height = req.height;
    if (req.steps !== undefined) body.num_steps = req.steps;
    if (req.seed != null) body.seed = req.seed;

    const res = await httpRequest(this.runUrl(ctx, model), {
      headers: this.headers(ctx),
      body,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });

    // The diffusion models stream the encoded image back as the response body,
    // while the newer ones answer with the standard envelope and a base64
    // `result.image`. Only the content-type distinguishes them, and both shapes
    // are served from the same URL, so it is read rather than assumed per model.
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    let bytes: Uint8Array;
    let mimeType: string;
    if (contentType.includes('json')) {
      const json = (await res.json()) as CloudflareEnvelope<WorkersImageResult>;
      const result = this.unwrap(json, model);
      if (!result.image) {
        throw new MeridianError('server_error', 'Workers AI returned a JSON result with no image', {
          providerId: this.descriptor.id,
          modelId: model,
        });
      }
      bytes = new Uint8Array(Buffer.from(result.image, 'base64'));
      // The JSON variant does not name the encoding it produced, so it is read
      // off the magic bytes instead of being guessed from the model id.
      mimeType = sniffImageMime(bytes);
    } else {
      // A declared type that is neither JSON nor an image is an error page that
      // arrived under a 200; trusting it would hand the caller a data: URL of
      // the error text dressed up as a picture.
      if (contentType && !contentType.startsWith('image/')) {
        throw new MeridianError('server_error', `Workers AI returned ${contentType} rather than image bytes`, {
          providerId: this.descriptor.id,
          modelId: model,
          details: { contentType },
        });
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      mimeType = contentType || sniffImageMime(bytes);
    }
    if (bytes.byteLength === 0) {
      throw new MeridianError('server_error', 'Workers AI returned an empty image body', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }

    const pricing = this.pricingLookup(model) ?? NEURON_PRICING;
    return {
      id: newId('img'),
      model,
      providerId: this.descriptor.id,
      assets: [
        {
          url: toDataUrl(bytes, mimeType),
          mimeType,
          width: req.width,
          height: req.height,
          seed: req.seed ?? null,
          bytes: bytes.byteLength,
        },
      ],
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, 0, 0, 1) },
    };
  }

  /**
   * Cloudflare answers a rejected inference with `success: false` and an
   * `errors` array, sometimes under a 200, so the envelope is the authority on
   * whether the call worked.
   */
  private unwrap<T>(env: CloudflareEnvelope<T>, model: string | null): T {
    const first = env.errors?.[0];
    if (env.success === false || first) {
      throw new MeridianError(errorCodeFor(first), `Cloudflare Workers AI: ${first?.message ?? 'request rejected'}`, {
        providerId: this.descriptor.id,
        modelId: model,
        details: first?.code !== undefined ? { cloudflareCode: first.code } : {},
      });
    }
    if (env.result == null) {
      throw new MeridianError('server_error', 'Workers AI returned an empty result', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }
    return env.result;
  }

  private usage(model: string, raw: WorkersTextResult['usage']): Usage {
    const promptTokens = raw?.prompt_tokens ?? 0;
    const completionTokens = raw?.completion_tokens ?? 0;
    const pricing = this.pricingLookup(model) ?? NEURON_PRICING;
    return {
      promptTokens,
      completionTokens,
      totalTokens: raw?.total_tokens ?? promptTokens + completionTokens,
      cost: computeCost(pricing, promptTokens, completionTokens),
    };
  }
}

/**
 * Workers AI takes `{ role, content }` with a plain string body and knows only
 * the three conversational roles, so a tool result is folded into the user turn
 * that carries it back and non-text parts are named rather than dropped.
 */
function toWorkersMessage(m: ChatMessage): { role: string; content: string } {
  const text = typeof m.content === 'string' ? m.content : partsToText(m.content);
  if (m.role === 'tool') return { role: 'user', content: `Tool result: ${text}` };
  return { role: m.role, content: text };
}

function partsToText(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

function deltaContent(evt: Record<string, unknown>): string | null {
  const choices = evt.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content;
  return typeof content === 'string' ? content : null;
}

function errorCodeFor(err: { code?: number; message?: string } | undefined): ErrorCode {
  const msg = (err?.message ?? '').toLowerCase();
  // 10000 is Cloudflare's generic authentication failure across the whole v4 API.
  if (err?.code === 10000 || msg.includes('authentication')) return 'authentication_failed';
  if (msg.includes('rate limit') || msg.includes('capacity')) return 'rate_limited';
  if (msg.includes('quota') || msg.includes('neuron')) return 'quota_exhausted';
  // 7000/7003 are routing failures, which for the run endpoint means the model
  // id in the path is not one this account can address.
  if (err?.code === 7000 || err?.code === 7003 || msg.includes('no route for that uri')) return 'model_unavailable';
  return 'server_error';
}

/** Container sniffing, so a mislabelled or unlabelled payload still renders. */
function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

function isPlaceholder(segment: string): boolean {
  return /^[{<:$]/.test(segment) || segment.length === 0;
}

function withAiSuffix(base: string): string {
  return base.endsWith('/ai') ? base : `${base}/ai`;
}

function forwardableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!key.toLowerCase().startsWith('x-meridian-')) out[key] = value;
  }
  return out;
}
