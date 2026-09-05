import {
  MeridianError,
  computeCost,
  modelKey,
  newId,
  type ChatMessage,
  type ChatRole,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type GeneratedAsset,
  type ImageRequest,
  type ImageResponse,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, toDataUrl } from '../http.js';

/** pollinations serves its two surfaces from separate origins. */
export interface PollinationsHosts {
  image: string;
  text: string;
}

const DEFAULT_HOSTS: PollinationsHosts = {
  image: 'https://image.pollinations.ai',
  text: 'https://text.pollinations.ai',
};

/**
 * Nothing on these endpoints can be billed, so FREE with no rates is the only
 * honest pricing. Kept here rather than read from the descriptor default so a
 * mis-filled catalog entry cannot make a keyless provider look metered.
 */
const FREE_PRICING: Pricing = {
  kind: 'FREE',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  freeQuota: null,
  note: null,
};

const ROLE_LABELS: Record<ChatRole, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result',
};

/**
 * pollinations.ai — the public, genuinely keyless API:
 * `GET image.pollinations.ai/prompt/{prompt}` returning raw image bytes,
 * `GET text.pollinations.ai/{prompt}` returning plain text, and the `/models`
 * listing each host publishes.
 *
 * Both surfaces are GET-with-query-string rather than JSON request bodies, and
 * neither returns usage counters, tool calls or a token stream. That is why
 * this adapter declares no tools and no streaming: the router must never send
 * tool-using or streaming work here believing it will be honoured.
 */
export class PollinationsAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private readonly hosts: PollinationsHosts;
  private pricingLookup: (providerModelId: string) => Pricing | null = () => null;

  constructor(descriptor: ProviderDescriptor, hosts: Partial<PollinationsHosts> = {}) {
    this.descriptor = descriptor;
    this.hosts = { ...DEFAULT_HOSTS, ...hosts };
  }

  setPricingLookup(fn: (providerModelId: string) => Pricing | null): void {
    this.pricingLookup = fn;
  }

  capabilities(): AdapterCapabilities {
    return {
      chat: true,
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

  /**
   * A descriptor holds a single baseUrl, which cannot express two origins, so
   * the pair lives here. An explicit ctx.baseUrl (test double, local mirror)
   * stands in for both surfaces.
   */
  private host(ctx: AdapterContext, surface: keyof PollinationsHosts): string {
    return (ctx.baseUrl ?? this.hosts[surface]).replace(/\/+$/, '');
  }

  /**
   * pollinations accepts no credential of any kind, so ctx.secret is never read
   * here — anonymous access is the whole point of the provider.
   */
  private headers(ctx: AdapterContext, accept: string): Record<string, string> {
    return { accept, ...ctx.headers };
  }

  /** An operator override still wins, but the fallback is FREE, never the descriptor default. */
  private pricingFor(model: string): Pricing {
    return this.pricingLookup(model) ?? FREE_PRICING;
  }

  /** Per-call timeout that can never outlive the overall deadline. */
  private budget(deadline: number, cap: number): number {
    return Math.max(1, Math.min(cap, deadline - Date.now()));
  }

  /* -------------------------------------------------------------- */
  /* Model discovery                                                 */
  /* -------------------------------------------------------------- */

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const [imageRaw, textRaw] = await Promise.all([
      httpJson<unknown>(`${this.host(ctx, 'image')}/models`, {
        method: 'GET',
        headers: this.headers(ctx, 'application/json'),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
      }),
      httpJson<unknown>(`${this.host(ctx, 'text')}/models`, {
        method: 'GET',
        headers: this.headers(ctx, 'application/json'),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
      }),
    ]);

    // The two listings are independent namespaces, so a name can appear in
    // both. Merge those into one descriptor carrying both modalities rather
    // than emitting a duplicate model id.
    const byName = new Map<string, ModelDescriptor>();
    for (const entry of asArray(imageRaw)) {
      const name = nameOf(entry);
      if (name) byName.set(name, this.describe(name, 'image', descriptionOf(entry)));
    }
    for (const entry of asArray(textRaw)) {
      const name = nameOf(entry);
      if (!name) continue;
      const existing = byName.get(name);
      if (existing) {
        // Neither listing promises unique names, so a repeated entry must not
        // append the same modality twice and make the model look mislabelled.
        if (!existing.modalities.includes('text')) existing.modalities.push('text');
        if (!existing.capabilities.includes('text')) existing.capabilities.push('text');
        continue;
      }
      byName.set(name, this.describe(name, 'text', descriptionOf(entry)));
    }
    return [...byName.values()];
  }

  private describe(name: string, surface: keyof PollinationsHosts, description: string | null): ModelDescriptor {
    const isImage = surface === 'image';
    return {
      id: modelKey(this.descriptor.id, name),
      providerId: this.descriptor.id,
      providerModelId: name,
      displayName: description ?? name,
      family: null,
      modalities: [isImage ? 'image' : 'text'],
      // Some text entries advertise vision or tools, but the GET endpoint this
      // adapter speaks takes a prompt string and answers with prose, so neither
      // is claimed on the model either.
      capabilities: [isImage ? 'image-generation' : 'text'],
      contextLength: null,
      maxOutputTokens: null,
      pricing: this.pricingFor(name),
      discovered: true,
      deprecated: false,
      tags: ['free', 'keyless'],
      updatedAt: Date.now(),
    };
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    // Both hosts, because they fail independently and one verdict has to cover
    // both surfaces. The listings are free; a generation probe would not be.
    const [image, text] = await Promise.all([this.probe(ctx, 'image'), this.probe(ctx, 'text')]);
    const latencyMs = Date.now() - started;
    if (image === null && text === null) return { ok: true, latencyMs };
    const detail = [image ? `image: ${image}` : null, text ? `text: ${text}` : null].filter(Boolean).join('; ');
    return { ok: false, latencyMs, detail };
  }

  /** Null when the surface answered; otherwise the failure detail. */
  private async probe(ctx: AdapterContext, surface: keyof PollinationsHosts): Promise<string | null> {
    try {
      await httpRequest(`${this.host(ctx, surface)}/models`, {
        method: 'GET',
        headers: this.headers(ctx, 'application/json'),
        timeoutMs: Math.min(ctx.timeoutMs, 15_000),
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /* -------------------------------------------------------------- */
  /* Images                                                          */
  /* -------------------------------------------------------------- */

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    if (req.referenceImage) {
      throw new MeridianError('unsupported_capability', 'Pollinations serves text-to-image only', {
        providerId: this.descriptor.id,
        modelId: req.model ?? null,
      });
    }
    const started = Date.now();
    // n images are n sequential requests, so ctx.timeoutMs has to be a budget
    // for the whole set; a per-call timeout alone would let the caller's
    // deadline be overrun n-fold.
    const deadline = started + ctx.timeoutMs;
    // Left empty when the caller pins nothing: the service picks its own
    // default, which is more truthful than this adapter naming one.
    const model = req.model ?? '';
    const count = Math.max(1, req.n ?? 1);
    const assets: GeneratedAsset[] = [];

    for (let i = 0; i < count; i++) {
      // A signal that aborted between requests never reaches the transport,
      // which only learns about an abort raised while a call is in flight.
      if (ctx.signal?.aborted) {
        throw new MeridianError('cancelled', 'Image generation cancelled', {
          providerId: this.descriptor.id,
          modelId: model || null,
          details: { produced: assets.length, requested: count },
        });
      }
      if (Date.now() >= deadline) {
        throw new MeridianError(
          'timeout',
          `Pollinations produced ${assets.length} of ${count} images within ${ctx.timeoutMs}ms`,
          {
            providerId: this.descriptor.id,
            modelId: model || null,
            details: { produced: assets.length, requested: count },
          },
        );
      }
      // Prompt plus seed is deterministic, so n > 1 has to move the seed;
      // deriving it from the caller's seed keeps the whole set reproducible.
      const seed = req.seed != null ? req.seed + i : randomSeed();
      // Sequential on purpose: the keyless tier is rate-limited per IP, where
      // parallel requests buy 429s rather than wall-clock time.
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
    seed: number,
    deadline: number,
    ctx: AdapterContext,
  ): Promise<GeneratedAsset> {
    const url = new URL(`${this.host(ctx, 'image')}/prompt/${encodeURIComponent(req.prompt)}`);
    url.searchParams.set('seed', String(seed));
    url.searchParams.set('nologo', 'true');
    // A gateway must not publish its callers' prompts: `private` keeps the
    // generation out of the public pollinations feed.
    url.searchParams.set('private', 'true');
    if (model) url.searchParams.set('model', model);
    if (req.width) url.searchParams.set('width', String(req.width));
    if (req.height) url.searchParams.set('height', String(req.height));

    const res = await httpRequest(url.toString(), {
      method: 'GET',
      headers: this.headers(ctx, 'image/*'),
      timeoutMs: this.budget(deadline, ctx.timeoutMs),
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model || null,
    });

    // The body is the image itself rather than JSON, so the content type is the
    // only signal that an error page slipped through with a 200.
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'image/jpeg';
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!mimeType.startsWith('image/') || bytes.byteLength === 0) {
      throw new MeridianError('server_error', `Pollinations returned ${mimeType} rather than image bytes`, {
        providerId: this.descriptor.id,
        modelId: model || null,
        details: { bytes: bytes.byteLength },
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

  /* -------------------------------------------------------------- */
  /* Text                                                            */
  /* -------------------------------------------------------------- */

  async chat(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse> {
    if (req.tools?.length) {
      throw new MeridianError('unsupported_capability', 'Pollinations text generation does not serve tool calls', {
        providerId: this.descriptor.id,
        modelId: req.model,
      });
    }
    const started = Date.now();
    const url = new URL(`${this.host(ctx, 'text')}/${encodeURIComponent(flattenMessages(req.messages))}`);
    if (req.model) url.searchParams.set('model', req.model);
    url.searchParams.set('private', 'true');
    // Same escape hatch as the JSON providers, except the wire slot for it on a
    // GET endpoint is the query string.
    for (const [key, value] of Object.entries(req.extra ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        url.searchParams.set(key, String(value));
      }
    }

    const res = await httpRequest(url.toString(), {
      method: 'GET',
      headers: this.headers(ctx, 'text/plain'),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });
    const content = await res.text();
    if (!content.trim()) {
      throw new MeridianError('server_error', 'Pollinations returned an empty completion', {
        providerId: this.descriptor.id,
        modelId: req.model,
      });
    }

    return {
      id: newId('cmpl'),
      model: req.model,
      providerId: this.descriptor.id,
      content,
      toolCalls: [],
      finishReason: 'stop',
      // The plain-text endpoint publishes no token counts, and a character
      // estimate must never be laundered into accounting, so the counters stay
      // at zero and only the cost — which is genuinely zero — is computed.
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: computeCost(this.pricingFor(req.model), 0, 0, 1),
      },
      latencyMs: Date.now() - started,
      ttftMs: null,
      viaFallback: false,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Wire-format helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * The text endpoint takes one prompt in the URL path and has no notion of a
 * message array, so roles collapse into labelled blocks. History length is
 * bounded by the server's URL limit, which fails loudly as a 4xx rather than
 * being silently truncated here.
 */
export function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      return text ? `${ROLE_LABELS[m.role]}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

/** The image listing is an array of bare names; the text listing is objects. */
function nameOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  if (entry && typeof entry === 'object') {
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

function descriptionOf(entry: unknown): string | null {
  if (entry && typeof entry === 'object') {
    const description = (entry as Record<string, unknown>).description;
    if (typeof description === 'string' && description.trim()) return description.trim();
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Seeds are plain integers; staying inside 32 bits avoids provider-side clamping. */
function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}
