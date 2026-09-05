import {
  MeridianError,
  computeCost,
  modelKey,
  newId,
  type Capability,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FinishReason,
  type Modality,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type StreamChunk,
  type ToolCall,
  type Usage,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, sseLines } from '../http.js';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string | null;
  index?: number;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  error?: { message?: string; status?: string };
}

interface GeminiModelEntry {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/**
 * Google's Generative Language API (generativelanguage.googleapis.com/v1beta):
 * `:generateContent`, `:streamGenerateContent?alt=sse`, `:embedContent` and
 * `GET /models`.
 *
 * Three shape differences from the OpenAI dialect are handled here so the rest
 * of the system only ever sees the neutral {@link ChatMessage}: the system
 * prompt is the top-level `systemInstruction`, the assistant role is called
 * `model`, and tool results are user-turn parts addressed by function *name*
 * rather than by call id — Gemini never issues call ids of its own, so the ids
 * we mint on the way out have to be resolved back to names on the way in.
 */
export class GeminiAdapter implements ProviderAdapter {
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
      chat: true,
      streaming: true,
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
  }

  private baseUrl(ctx: AdapterContext): string {
    return (ctx.baseUrl ?? this.descriptor.baseUrl).replace(/\/+$/, '');
  }

  private headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    if (!ctx.secret) {
      throw new MeridianError('authentication_failed', 'Google Generative Language API requires an API key', {
        providerId: this.descriptor.id,
      });
    }
    // The key travels in a header rather than the `?key=` query parameter so it
    // never lands in a proxy or access log.
    return {
      'content-type': 'application/json',
      'x-goog-api-key': ctx.secret,
      ...extra,
      ...ctx.headers,
    };
  }

  /* -------------------------------------------------------------- */
  /* Model discovery                                                 */
  /* -------------------------------------------------------------- */

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const out: ModelDescriptor[] = [];
    let pageToken: string | undefined;
    // ctx.timeoutMs is the budget for the whole listing, not for each page:
    // spending it again per page would multiply the caller's deadline by the
    // page count. A truncated catalog would look authoritative, so an exhausted
    // budget fails the call rather than returning the pages that did arrive.
    const deadline = Date.now() + ctx.timeoutMs;
    // The listing is paged and the page size is capped server-side; 20 pages is
    // far more than the catalog has ever held and stops a bad token looping.
    for (let page = 0; page < 20; page++) {
      if (ctx.signal?.aborted) {
        throw new MeridianError('cancelled', 'Model listing cancelled', { providerId: this.descriptor.id });
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new MeridianError('timeout', `Model listing for ${this.descriptor.id} exceeded ${ctx.timeoutMs}ms`, {
          providerId: this.descriptor.id,
        });
      }
      const url = `${this.baseUrl(ctx)}/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const json = await httpJson<{ models?: GeminiModelEntry[]; nextPageToken?: string }>(url, {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: remainingMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
      });
      for (const entry of json.models ?? []) {
        const mapped = this.mapModel(entry);
        if (mapped) out.push(mapped);
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return out;
  }

  private mapModel(raw: GeminiModelEntry): ModelDescriptor | null {
    const id = bareModelId(raw.name ?? '');
    if (!id) return null;
    const methods = raw.supportedGenerationMethods ?? [];
    const generates = methods.includes('generateContent');
    const embeds = methods.includes('embedContent');
    // Tuning-only and counting-only entries serve neither surface this adapter
    // implements; offering them would be exactly the fake support we forbid.
    if (!generates && !embeds) return null;

    const modalities: Modality[] = [];
    const capabilities: Capability[] = [];
    if (generates) {
      modalities.push('text');
      capabilities.push('text', 'tools');
      if (methods.includes('streamGenerateContent')) capabilities.push('streaming');
      // The listing carries no per-model input-modality field, so the family
      // prefix is the only honest signal that image parts will be accepted.
      if (id.startsWith('gemini-')) {
        modalities.push('vision');
        capabilities.push('vision');
      }
      if ((raw.inputTokenLimit ?? 0) >= 128_000) capabilities.push('long-context');
    }
    if (embeds) {
      modalities.push('embedding');
      capabilities.push('embedding');
    }

    return {
      id: modelKey(this.descriptor.id, id),
      providerId: this.descriptor.id,
      providerModelId: id,
      displayName: raw.displayName ?? id,
      family: familyOf(id),
      modalities,
      capabilities,
      contextLength: raw.inputTokenLimit ?? null,
      maxOutputTokens: raw.outputTokenLimit ?? null,
      pricing: this.pricingLookup(id) ?? this.descriptor.defaultPricing,
      discovered: true,
      deprecated: false,
      tags: [],
      updatedAt: Date.now(),
    };
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      // The listing endpoint is free and still exercises the credential.
      await httpRequest(`${this.baseUrl(ctx)}/models?pageSize=1`, {
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

  private body(req: CompletionRequest): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.topP !== undefined) generationConfig.topP = req.topP;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.stop?.length) generationConfig.stopSequences = req.stop;
    if (req.responseFormat && req.responseFormat.type !== 'text') {
      generationConfig.responseMimeType = 'application/json';
      if (req.responseFormat.schema) generationConfig.responseSchema = req.responseFormat.schema;
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    if (req.tools?.length) {
      // Every declaration goes in a single tools entry: Gemini treats the array
      // as a list of tool *types*, not a list of functions.
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
      const mode = functionCallingMode(req.toolChoice);
      if (mode) {
        body.toolConfig = {
          functionCallingConfig:
            typeof req.toolChoice === 'object'
              ? { mode, allowedFunctionNames: [req.toolChoice.name] }
              : { mode },
        };
      }
    }
    if (req.extra) Object.assign(body, req.extra);
    return body;
  }

  async chat(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse> {
    const started = Date.now();
    const model = bareModelId(req.model);
    const json = await httpJson<GeminiGenerateResponse>(
      `${this.baseUrl(ctx)}/models/${encodeURIComponent(model)}:generateContent`,
      {
        headers: this.headers(ctx),
        body: this.body(req),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      },
    );
    if (json.error?.message) {
      throw new MeridianError('server_error', json.error.message, { providerId: this.descriptor.id, modelId: model });
    }
    const candidate = json.candidates?.[0];
    if (!candidate) {
      // A prompt rejected by the safety filter comes back with no candidates at
      // all, only promptFeedback — that is a content decision, not an outage.
      const blocked = json.promptFeedback?.blockReason;
      if (blocked) {
        throw new MeridianError('content_filtered', `Gemini blocked the prompt (${blocked})`, {
          providerId: this.descriptor.id,
          modelId: model,
        });
      }
      throw new MeridianError('server_error', 'Gemini returned no candidates', {
        providerId: this.descriptor.id,
        modelId: model,
      });
    }

    const parts = candidate.content?.parts ?? [];
    const toolCalls = toolCallsFrom(parts);
    let finishReason = mapGeminiFinishReason(candidate.finishReason);
    // Gemini reports STOP even when the turn is entirely function calls.
    if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_calls';

    return {
      id: newId('cmpl'),
      model: req.model,
      providerId: this.descriptor.id,
      content: parts.map((p) => p.text ?? '').join(''),
      toolCalls,
      finishReason,
      usage: this.usage(model, json.usageMetadata),
      latencyMs: Date.now() - started,
      ttftMs: null,
      viaFallback: false,
    };
  }

  async *chatStream(req: CompletionRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const model = bareModelId(req.model);
    const res = await httpRequest(
      `${this.baseUrl(ctx)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        headers: this.headers(ctx, { accept: 'text/event-stream' }),
        body: this.body(req),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      },
    );

    yield { type: 'start', model: req.model, providerId: this.descriptor.id };

    let usageMetadata: GeminiUsageMetadata | undefined;
    let finish: FinishReason = 'stop';
    let sawToolCall = false;

    for await (const data of sseLines(res, ctx.signal)) {
      let evt: GeminiGenerateResponse;
      try {
        evt = JSON.parse(data) as GeminiGenerateResponse;
      } catch {
        continue;
      }
      if (evt.error?.message) {
        yield { type: 'error', error: evt.error.message, code: 'server_error' };
        return;
      }
      const blocked = evt.promptFeedback?.blockReason;
      if (blocked && !evt.candidates?.length) {
        yield { type: 'error', error: `Gemini blocked the prompt (${blocked})`, code: 'content_filtered' };
        return;
      }
      // Every frame repeats the cumulative counts; the last one seen wins.
      if (evt.usageMetadata) usageMetadata = evt.usageMetadata;
      const candidate = evt.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) yield { type: 'text', delta: part.text };
        // Unlike the OpenAI dialect, a functionCall arrives whole in one frame,
        // so there is no partial-argument buffer to assemble.
        if (part.functionCall?.name) {
          sawToolCall = true;
          yield {
            type: 'tool_call',
            toolCall: { id: newId('call'), name: part.functionCall.name, arguments: part.functionCall.args ?? {} },
          };
        }
      }
      if (candidate.finishReason) finish = mapGeminiFinishReason(candidate.finishReason);
    }

    if (sawToolCall && finish === 'stop') finish = 'tool_calls';
    yield { type: 'usage', usage: this.usage(model, usageMetadata) };
    yield { type: 'done', finishReason: finish };
  }

  /* -------------------------------------------------------------- */
  /* Embeddings                                                      */
  /* -------------------------------------------------------------- */

  async embed(req: EmbeddingRequest, ctx: AdapterContext): Promise<EmbeddingResponse> {
    const started = Date.now();
    const model = bareModelId(req.model ?? '');
    if (!model) {
      throw new MeridianError('invalid_request', 'Gemini embeddings require a model id', {
        providerId: this.descriptor.id,
      });
    }
    const qualified = `models/${model}`;
    const url = `${this.baseUrl(ctx)}/models/${encodeURIComponent(model)}`;
    let embeddings: number[][];

    if (req.input.length === 1) {
      const json = await httpJson<{ embedding?: { values?: number[] } }>(`${url}:embedContent`, {
        headers: this.headers(ctx),
        body: { model: qualified, content: { parts: [{ text: req.input[0] }] } },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      });
      embeddings = [json.embedding?.values ?? []];
    } else {
      // :embedContent takes exactly one content, so a multi-input request goes
      // through the batch route rather than N sequential round trips.
      const json = await httpJson<{ embeddings?: { values?: number[] }[] }>(`${url}:batchEmbedContents`, {
        headers: this.headers(ctx),
        body: {
          requests: req.input.map((text) => ({ model: qualified, content: { parts: [{ text }] } })),
        },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
        modelId: model,
      });
      embeddings = (json.embeddings ?? []).map((e) => e.values ?? []);
    }

    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      id: newId('emb'),
      model,
      providerId: this.descriptor.id,
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
      latencyMs: Date.now() - started,
      // The embedding endpoints return no usageMetadata; reporting zeros keeps
      // accounting honest rather than billing against an invented estimate.
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: computeCost(pricing, 0, 0, req.input.length),
      },
    };
  }

  /* -------------------------------------------------------------- */

  private usage(model: string, raw: GeminiUsageMetadata | undefined): Usage {
    const promptTokens = raw?.promptTokenCount ?? 0;
    const completionTokens = raw?.candidatesTokenCount ?? 0;
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      promptTokens,
      completionTokens,
      totalTokens: raw?.totalTokenCount ?? promptTokens + completionTokens,
      cost: computeCost(pricing, promptTokens, completionTokens),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Wire-format helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fold system messages into `systemInstruction` and convert the rest into
 * Gemini `contents`. Consecutive same-role turns are merged: Gemini expects an
 * alternating transcript and a tool result has to ride on a user turn.
 */
export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string | null;
  contents: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const contents: Record<string, unknown>[] = [];
  // Gemini addresses a tool result by function name, so the ids we minted for
  // the assistant's calls have to be resolved back before the result is sent.
  const nameByCallId = new Map<string, string>();

  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) (last.parts as GeminiPart[]).push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const name = (m.toolCallId ? nameByCallId.get(m.toolCallId) : undefined) ?? m.name;
      if (!name) continue;
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      push('user', [{ functionResponse: { name, response: asResponseObject(text) } }]);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const p of m.content) parts.push(toPart(p));
    }
    for (const tc of m.toolCalls ?? []) {
      nameByCallId.set(tc.id, tc.name);
      parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
    }
    push(role, parts);
  }

  return { systemInstruction: systemParts.length ? systemParts.join('\n\n') : null, contents };
}

function toPart(p: ContentPart): GeminiPart {
  if (p.type === 'text') return { text: p.text };
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(p.url);
  if (inline) return { inlineData: { mimeType: p.mimeType ?? inline[1], data: inline[2] } };
  // A bare URI is only resolvable when it points at the Files API (or, for
  // video, YouTube); anything else is rejected by the server, not by us.
  return { fileData: { mimeType: p.mimeType, fileUri: p.url } };
}

function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

/** `functionResponse.response` must be an object, never a bare string. */
function asResponseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to the string wrapper */
    }
  }
  return { result: text };
}

function toolCallsFrom(parts: GeminiPart[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const part of parts) {
    const name = part.functionCall?.name;
    if (!name) continue;
    // Gemini issues no call id of its own; the agent loop needs one to match
    // the result back, so we mint it here and remember it on the way out.
    out.push({ id: newId('call'), name, arguments: part.functionCall?.args ?? {} });
  }
  return out;
}

export function mapGeminiFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
      return 'error';
    default:
      return 'stop';
  }
}

function functionCallingMode(choice: CompletionRequest['toolChoice']): string | null {
  if (choice === undefined) return null;
  if (choice === 'none') return 'NONE';
  if (choice === 'auto') return 'AUTO';
  // Both "required" and a pinned tool force a call; the pin adds the name list.
  return 'ANY';
}

/** Accepts both `gemini-2.5-flash` and the fully qualified `models/...` form. */
function bareModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function familyOf(id: string): string | null {
  const head = id.split('-')[0];
  return head ? head.toLowerCase() : null;
}
