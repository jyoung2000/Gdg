import {
  MeridianError,
  computeCost,
  modelKey,
  newId,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FinishReason,
  type ImageRequest,
  type ImageResponse,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type SpeechRequest,
  type SpeechResponse,
  type StreamChunk,
  type ToolCall,
  type TranscriptionRequest,
  type TranscriptionResponse,
  type Usage,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, sseLines, toDataUrl } from '../http.js';

/** Which OpenAI-compatible surfaces a given provider actually exposes. */
export interface OpenAICompatibleOptions {
  /** Enable the endpoints this provider genuinely serves. Nothing is assumed. */
  supports: Partial<AdapterCapabilities>;
  /** Provider-specific auth header. Defaults to `Authorization: Bearer <secret>`. */
  authHeader?: (secret: string) => Record<string, string>;
  /** Extra headers sent on every call (attribution, API versions, ...). */
  staticHeaders?: Record<string, string>;
  /** Path overrides for providers that deviate from the standard routes. */
  paths?: Partial<Record<'chat' | 'models' | 'embeddings' | 'images' | 'speech' | 'transcriptions', string>>;
  /** Pricing applied to discovered models when the listing carries none. */
  pricingForDiscovered?: (raw: Record<string, unknown>, descriptor: ProviderDescriptor) => Pricing;
  /** Map a raw listing entry to a descriptor; return null to drop it. */
  mapModel?: (raw: Record<string, unknown>, descriptor: ProviderDescriptor) => ModelDescriptor | null;
  /** Extra body fields merged into every chat request. */
  chatBodyExtras?: Record<string, unknown>;
  /** Some providers reject `max_tokens` and require `max_completion_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

interface OAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OAIChoice {
  index: number;
  message?: { content?: string | null; tool_calls?: OAIToolCallDelta[]; reasoning?: string | null };
  delta?: { content?: string | null; tool_calls?: OAIToolCallDelta[] };
  finish_reason?: string | null;
}

interface OAIResponse {
  id?: string;
  model?: string;
  choices?: OAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/**
 * The OpenAI chat-completions dialect, which most hosted inference providers
 * implement. One well-tested implementation backs OpenRouter, Groq, Cerebras,
 * Together, DeepSeek, Mistral, Ollama, vLLM, llama.cpp and the rest, rather
 * than a dozen near-identical copies.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  protected readonly options: OpenAICompatibleOptions;
  /** Pricing lookup for models known to the static catalog. */
  protected pricingLookup: (providerModelId: string) => Pricing | null = () => null;

  constructor(descriptor: ProviderDescriptor, options: OpenAICompatibleOptions) {
    this.descriptor = descriptor;
    this.options = options;
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
      image: false,
      video: false,
      speech: false,
      transcription: false,
      discovery: this.descriptor.supportsDiscovery,
      health: true,
      ...this.options.supports,
    };
  }

  protected baseUrl(ctx: AdapterContext): string {
    return (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
  }

  protected path(kind: keyof NonNullable<OpenAICompatibleOptions['paths']>, dflt: string): string {
    return this.options.paths?.[kind] ?? dflt;
  }

  protected headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.options.staticHeaders };
    if (ctx.secret) {
      Object.assign(h, this.options.authHeader ? this.options.authHeader(ctx.secret) : { authorization: `Bearer ${ctx.secret}` });
    } else if (this.descriptor.auth !== 'none') {
      throw new MeridianError('authentication_failed', `${this.descriptor.name} requires a credential`, {
        providerId: this.descriptor.id,
      });
    }
    return { ...h, ...extra, ...ctx.headers };
  }

  /* -------------------------------------------------------------- */
  /* Model discovery                                                 */
  /* -------------------------------------------------------------- */

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    if (!this.descriptor.supportsDiscovery) return [];
    const url = `${this.baseUrl(ctx)}${this.path('models', '/models')}`;
    const raw = await httpJson<{ data?: unknown[]; models?: unknown[] }>(url, {
      method: 'GET',
      headers: this.headers(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
    });
    const entries = (raw.data ?? raw.models ?? []) as Record<string, unknown>[];
    const out: ModelDescriptor[] = [];
    for (const entry of entries) {
      const mapped = this.options.mapModel
        ? this.options.mapModel(entry, this.descriptor)
        : this.defaultMapModel(entry);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  protected defaultMapModel(raw: Record<string, unknown>): ModelDescriptor | null {
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : null;
    if (!id) return null;
    const pricing =
      this.pricingLookup(id) ??
      this.options.pricingForDiscovered?.(raw, this.descriptor) ??
      this.descriptor.defaultPricing;
    const ctxLen =
      numberOf(raw.context_length) ??
      numberOf(raw.context_window) ??
      numberOf((raw.top_provider as Record<string, unknown> | undefined)?.context_length) ??
      null;
    const caps = this.capabilities();
    return {
      id: modelKey(this.descriptor.id, id),
      providerId: this.descriptor.id,
      providerModelId: id,
      displayName: typeof raw.name === 'string' ? raw.name : id,
      family: familyOf(id),
      modalities: ['text'],
      capabilities: [
        'text',
        ...(caps.streaming ? (['streaming'] as const) : []),
        ...(caps.tools ? (['tools'] as const) : []),
      ],
      contextLength: ctxLen,
      maxOutputTokens: numberOf((raw.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens) ?? null,
      pricing,
      discovered: true,
      deprecated: false,
      tags: [],
      updatedAt: Date.now(),
    };
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    // Prefer the listing endpoint: it is free everywhere that offers it.
    const url = this.descriptor.supportsDiscovery
      ? `${this.baseUrl(ctx)}${this.path('models', '/models')}`
      : this.baseUrl(ctx);
    try {
      await httpRequest(url, {
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
  /* Chat                                                            */
  /* -------------------------------------------------------------- */

  protected chatBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const maxField = this.options.maxTokensField ?? 'max_tokens';
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => toOAIMessage(m)),
      stream,
      ...this.options.chatBodyExtras,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body[maxField] = req.maxTokens;
    if (req.stop?.length) body.stop = req.stop;
    if (stream) body.stream_options = { include_usage: true };
    if (req.tools?.length && this.capabilities().tools) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (req.toolChoice) {
        body.tool_choice =
          typeof req.toolChoice === 'string'
            ? req.toolChoice
            : { type: 'function', function: { name: req.toolChoice.name } };
      }
    }
    if (req.responseFormat) {
      body.response_format =
        req.responseFormat.type === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'response', schema: req.responseFormat.schema, strict: true } }
          : { type: req.responseFormat.type };
    }
    if (req.extra) Object.assign(body, req.extra);
    return body;
  }

  async chat(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse> {
    if (!this.capabilities().chat) {
      throw new MeridianError('unsupported_capability', `${this.descriptor.name} does not serve chat`, {
        providerId: this.descriptor.id,
      });
    }
    const started = Date.now();
    const url = `${this.baseUrl(ctx)}${this.path('chat', '/chat/completions')}`;
    const json = await httpJson<OAIResponse>(url, {
      headers: this.headers(ctx),
      body: this.chatBody(req, false),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });
    if (json.error?.message) {
      throw new MeridianError('server_error', json.error.message, { providerId: this.descriptor.id, modelId: req.model });
    }
    const choice = json.choices?.[0];
    if (!choice) {
      throw new MeridianError('server_error', 'Provider returned no choices', {
        providerId: this.descriptor.id,
        modelId: req.model,
      });
    }
    const usage = this.usageFor(req.model, json.usage);
    return {
      id: json.id ?? newId('cmpl'),
      model: req.model,
      providerId: this.descriptor.id,
      content: choice.message?.content ?? '',
      toolCalls: parseToolCalls(choice.message?.tool_calls ?? []),
      finishReason: mapFinishReason(choice.finish_reason),
      usage,
      latencyMs: Date.now() - started,
      ttftMs: null,
      viaFallback: false,
    };
  }

  async *chatStream(req: CompletionRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    if (!this.capabilities().streaming) {
      // Degrade gracefully: emit the non-streaming result as one chunk.
      const res = await this.chat(req, ctx);
      yield { type: 'start', model: req.model, providerId: this.descriptor.id };
      if (res.content) yield { type: 'text', delta: res.content };
      for (const tc of res.toolCalls) yield { type: 'tool_call', toolCall: tc };
      yield { type: 'usage', usage: res.usage };
      yield { type: 'done', finishReason: res.finishReason };
      return;
    }
    const url = `${this.baseUrl(ctx)}${this.path('chat', '/chat/completions')}`;
    const res = await httpRequest(url, {
      headers: this.headers(ctx, { accept: 'text/event-stream' }),
      body: this.chatBody(req, true),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });

    yield { type: 'start', model: req.model, providerId: this.descriptor.id };

    // Tool call arguments arrive as fragments keyed by index; assemble them.
    const partials = new Map<number, { id: string; name: string; args: string }>();
    let finish: FinishReason = 'stop';
    let usage: Usage | null = null;

    for await (const data of sseLines(res, ctx.signal)) {
      let evt: OAIResponse;
      try {
        evt = JSON.parse(data) as OAIResponse;
      } catch {
        continue; // Ignore keep-alive comments and malformed frames.
      }
      if (evt.error?.message) {
        yield { type: 'error', error: evt.error.message, code: 'server_error' };
        return;
      }
      if (evt.usage) usage = this.usageFor(req.model, evt.usage);
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? choice.message;
      if (delta?.content) yield { type: 'text', delta: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partials.get(idx) ?? { id: tc.id ?? newId('call'), name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partials.set(idx, cur);
      }
      if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason);
    }

    for (const p of [...partials.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (!p.name) continue;
      yield { type: 'tool_call', toolCall: { id: p.id, name: p.name, arguments: safeJsonObject(p.args) } };
      if (finish === 'stop') finish = 'tool_calls';
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason: finish };
  }

  /* -------------------------------------------------------------- */
  /* Embeddings                                                      */
  /* -------------------------------------------------------------- */

  async embed(req: EmbeddingRequest, ctx: AdapterContext): Promise<EmbeddingResponse> {
    if (!this.capabilities().embedding) {
      throw new MeridianError('unsupported_capability', `${this.descriptor.name} does not serve embeddings`, {
        providerId: this.descriptor.id,
      });
    }
    const started = Date.now();
    const model = req.model ?? '';
    const url = `${this.baseUrl(ctx)}${this.path('embeddings', '/embeddings')}`;
    const json = await httpJson<{
      data?: { embedding: number[]; index: number }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    }>(url, {
      headers: this.headers(ctx),
      body: { model, input: req.input },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
    const rows = (json.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return {
      id: newId('emb'),
      model,
      providerId: this.descriptor.id,
      embeddings: rows,
      dimensions: rows[0]?.length ?? 0,
      latencyMs: Date.now() - started,
      usage: this.usageFor(model, { prompt_tokens: json.usage?.prompt_tokens, completion_tokens: 0 }),
    };
  }

  /* -------------------------------------------------------------- */
  /* Images                                                          */
  /* -------------------------------------------------------------- */

  async image(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse> {
    if (!this.capabilities().image) {
      throw new MeridianError('unsupported_capability', `${this.descriptor.name} does not serve image generation`, {
        providerId: this.descriptor.id,
      });
    }
    const started = Date.now();
    const model = req.model ?? '';
    const url = `${this.baseUrl(ctx)}${this.path('images', '/images/generations')}`;
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: req.n ?? 1,
      response_format: 'b64_json',
    };
    if (req.width && req.height) body.size = `${req.width}x${req.height}`;
    const json = await httpJson<{ data?: { b64_json?: string; url?: string; revised_prompt?: string }[] }>(url, {
      headers: this.headers(ctx),
      body,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
    const assets = (json.data ?? []).map((d) => ({
      url: d.b64_json ? `data:image/png;base64,${d.b64_json}` : (d.url ?? ''),
      mimeType: 'image/png',
      width: req.width,
      height: req.height,
      seed: req.seed ?? null,
    }));
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      id: newId('img'),
      model,
      providerId: this.descriptor.id,
      assets,
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, 0, 0, assets.length) },
    };
  }

  /* -------------------------------------------------------------- */
  /* Speech and transcription                                        */
  /* -------------------------------------------------------------- */

  async speech(req: SpeechRequest, ctx: AdapterContext): Promise<SpeechResponse> {
    if (!this.capabilities().speech) {
      throw new MeridianError('unsupported_capability', `${this.descriptor.name} does not serve speech synthesis`, {
        providerId: this.descriptor.id,
      });
    }
    const started = Date.now();
    const model = req.model ?? '';
    const format = req.format ?? 'mp3';
    const url = `${this.baseUrl(ctx)}${this.path('speech', '/audio/speech')}`;
    const res = await httpRequest(url, {
      headers: this.headers(ctx),
      body: { model, input: req.text, voice: req.voice ?? 'alloy', response_format: format, speed: req.speed ?? 1 },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: model,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      id: newId('tts'),
      model,
      providerId: this.descriptor.id,
      asset: { url: toDataUrl(bytes, mimeForAudio(format)), mimeType: mimeForAudio(format), bytes: bytes.byteLength },
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, req.text.length, 0, 1) },
    };
  }

  async transcribe(req: TranscriptionRequest, ctx: AdapterContext): Promise<TranscriptionResponse> {
    if (!this.capabilities().transcription) {
      throw new MeridianError('unsupported_capability', `${this.descriptor.name} does not serve transcription`, {
        providerId: this.descriptor.id,
      });
    }
    const started = Date.now();
    const model = req.model ?? '';
    const form = new FormData();
    form.append('file', new Blob([req.audio as unknown as BlobPart], { type: req.mimeType }), 'audio');
    form.append('model', model);
    if (req.language) form.append('language', req.language);
    if (req.prompt) form.append('prompt', req.prompt);
    // Let fetch set the multipart boundary; sending our own content-type breaks it.
    const headers = this.headers(ctx);
    delete headers['content-type'];
    const json = await httpJson<{ text?: string; language?: string; duration?: number }>(
      `${this.baseUrl(ctx)}${this.path('transcriptions', '/audio/transcriptions')}`,
      {
        headers,
        rawBody: form,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      },
    );
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      id: newId('stt'),
      model,
      providerId: this.descriptor.id,
      text: json.text ?? '',
      language: json.language ?? null,
      durationSec: json.duration ?? null,
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: computeCost(pricing, 0, 0, 1) },
    };
  }

  /* -------------------------------------------------------------- */

  protected usageFor(
    model: string,
    raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  ): Usage {
    const promptTokens = raw?.prompt_tokens ?? 0;
    const completionTokens = raw?.completion_tokens ?? 0;
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      promptTokens,
      completionTokens,
      totalTokens: raw?.total_tokens ?? promptTokens + completionTokens,
      cost: computeCost(pricing, promptTokens, completionTokens),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Wire-format helpers                                                 */
/* ------------------------------------------------------------------ */

function toOAIMessage(m: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role };
  if (m.name) base.name = m.name;
  if (m.role === 'tool') {
    base.tool_call_id = m.toolCallId;
    base.content = typeof m.content === 'string' ? m.content : partsToText(m.content);
    return base;
  }
  if (m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  base.content =
    typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => toOAIPart(p));
  return base;
}

function toOAIPart(p: ContentPart): Record<string, unknown> {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.type === 'image') return { type: 'image_url', image_url: { url: p.url } };
  return { type: 'input_audio', input_audio: { data: p.url, format: p.mimeType ?? 'wav' } };
}

function partsToText(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

export function parseToolCalls(raw: OAIToolCallDelta[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const tc of raw) {
    const name = tc.function?.name;
    if (!name) continue;
    out.push({ id: tc.id ?? newId('call'), name, arguments: safeJsonObject(tc.function?.arguments ?? '{}') });
  }
  return out;
}

/**
 * Tool arguments are model-generated and routinely malformed. Never throw:
 * the agent loop reports a parse failure back to the model as a tool error,
 * which it can recover from, whereas an exception kills the whole task.
 */
export function safeJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // Recover the common "trailing prose after the object" failure.
    const end = trimmed.lastIndexOf('}');
    if (end > 0) {
      try {
        return JSON.parse(trimmed.slice(0, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { __unparsed: trimmed };
  }
}

export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function numberOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function familyOf(modelId: string): string | null {
  const tail = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
  const m = /^([a-z]+(?:[-.]?\d+(?:\.\d+)?)?)/i.exec(tail);
  return m ? m[1].toLowerCase() : null;
}

function mimeForAudio(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'flac':
      return 'audio/flac';
    default:
      return 'audio/mpeg';
  }
}
