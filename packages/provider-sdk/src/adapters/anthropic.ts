import {
  MeridianError,
  computeCost,
  modelKey,
  newId,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentPart,
  type FinishReason,
  type ModelDescriptor,
  type Pricing,
  type ProviderDescriptor,
  type StreamChunk,
  type ToolCall,
  type Usage,
} from '@meridian/shared';
import type { AdapterCapabilities, AdapterContext, ProviderAdapter } from '../adapter.js';
import { httpJson, httpRequest, sseLines } from '../http.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Anthropic's Messages API.
 *
 * It differs from the OpenAI dialect in three ways that matter: the system
 * prompt is a top-level field rather than a message, content is always a list
 * of typed blocks, and tool results are user-role blocks rather than a
 * dedicated role. All three are handled here so the rest of the system only
 * ever sees the neutral {@link ChatMessage} shape.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  private readonly apiVersion: string;
  private pricingLookup: (providerModelId: string) => Pricing | null = () => null;

  constructor(descriptor: ProviderDescriptor, apiVersion = '2023-06-01') {
    this.descriptor = descriptor;
    this.apiVersion = apiVersion;
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
      embedding: false,
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
      throw new MeridianError('authentication_failed', 'Anthropic requires an API key', { providerId: this.descriptor.id });
    }
    return {
      'content-type': 'application/json',
      'x-api-key': ctx.secret,
      'anthropic-version': this.apiVersion,
      ...extra,
      ...ctx.headers,
    };
  }

  async listModels(ctx: AdapterContext): Promise<ModelDescriptor[]> {
    const json = await httpJson<{ data?: { id: string; display_name?: string; created_at?: string }[] }>(
      `${this.baseUrl(ctx)}/models?limit=100`,
      {
        method: 'GET',
        headers: this.headers(ctx),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        providerId: this.descriptor.id,
      },
    );
    return (json.data ?? []).map((m) => ({
      id: modelKey(this.descriptor.id, m.id),
      providerId: this.descriptor.id,
      providerModelId: m.id,
      displayName: m.display_name ?? m.id,
      family: 'claude',
      modalities: ['text', 'vision'] as ModelDescriptor['modalities'],
      capabilities: ['text', 'vision', 'tools', 'streaming', 'reasoning', 'long-context'] as ModelDescriptor['capabilities'],
      contextLength: 200_000,
      maxOutputTokens: 8192,
      pricing: this.pricingLookup(m.id) ?? this.descriptor.defaultPricing,
      discovered: true,
      deprecated: false,
      tags: ['reasoning', 'coding'],
      updatedAt: Date.now(),
    }));
  }

  async healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await httpRequest(`${this.baseUrl(ctx)}/models?limit=1`, {
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
    const { system, messages } = splitSystem(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      // Anthropic requires max_tokens; 4096 is a safe default for every model.
      max_tokens: req.maxTokens ?? 4096,
      stream,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop?.length) body.stop_sequences = req.stop;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      if (req.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else if (typeof req.toolChoice === 'object') body.tool_choice = { type: 'tool', name: req.toolChoice.name };
    }
    if (req.extra) Object.assign(body, req.extra);
    return body;
  }

  async chat(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse> {
    const started = Date.now();
    const json = await httpJson<AnthropicMessageResponse>(`${this.baseUrl(ctx)}/messages`, {
      headers: this.headers(ctx),
      body: this.body(req, false),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });
    if (json.error?.message) {
      throw new MeridianError('server_error', json.error.message, { providerId: this.descriptor.id, modelId: req.model });
    }
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = (json.content ?? [])
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({ id: b.id ?? newId('call'), name: b.name as string, arguments: b.input ?? {} }));

    return {
      id: json.id ?? newId('cmpl'),
      model: req.model,
      providerId: this.descriptor.id,
      content: text,
      toolCalls,
      finishReason: mapStopReason(json.stop_reason),
      usage: this.usage(req.model, json.usage?.input_tokens ?? 0, json.usage?.output_tokens ?? 0),
      latencyMs: Date.now() - started,
      ttftMs: null,
      viaFallback: false,
    };
  }

  async *chatStream(req: CompletionRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const res = await httpRequest(`${this.baseUrl(ctx)}/messages`, {
      headers: this.headers(ctx, { accept: 'text/event-stream' }),
      body: this.body(req, true),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      providerId: this.descriptor.id,
      modelId: req.model,
    });

    yield { type: 'start', model: req.model, providerId: this.descriptor.id };

    // Tool inputs stream as partial JSON keyed by content-block index.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finish: FinishReason = 'stop';

    for await (const data of sseLines(res, ctx.signal)) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = evt.type as string | undefined;

      if (type === 'message_start') {
        const usage = ((evt.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, number>;
        inputTokens = usage.input_tokens ?? 0;
      } else if (type === 'content_block_start') {
        const block = evt.content_block as AnthropicContentBlock | undefined;
        if (block?.type === 'tool_use' && block.name) {
          toolBlocks.set(evt.index as number, { id: block.id ?? newId('call'), name: block.name, json: '' });
        }
      } else if (type === 'content_block_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', delta: delta.text };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const b = toolBlocks.get(evt.index as number);
          if (b) b.json += delta.partial_json;
        }
      } else if (type === 'message_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') finish = mapStopReason(delta.stop_reason);
        const usage = evt.usage as Record<string, number> | undefined;
        if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
      } else if (type === 'error') {
        const err = evt.error as Record<string, unknown> | undefined;
        yield { type: 'error', error: String(err?.message ?? 'stream error'), code: 'server_error' };
        return;
      }
    }

    for (const b of toolBlocks.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = b.json.trim() ? (JSON.parse(b.json) as Record<string, unknown>) : {};
      } catch {
        args = { __unparsed: b.json };
      }
      yield { type: 'tool_call', toolCall: { id: b.id, name: b.name, arguments: args } };
      if (finish === 'stop') finish = 'tool_calls';
    }
    yield { type: 'usage', usage: this.usage(req.model, inputTokens, outputTokens) };
    yield { type: 'done', finishReason: finish };
  }

  private usage(model: string, input: number, output: number): Usage {
    const pricing = this.pricingLookup(model) ?? this.descriptor.defaultPricing;
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: input + output,
      cost: computeCost(pricing, input, output),
    };
  }
}

/* ------------------------------------------------------------------ */

/**
 * Split system messages out and convert the rest into Anthropic blocks.
 * Consecutive same-role messages are merged, which Anthropic requires.
 */
export function splitSystem(messages: ChatMessage[]): { system: string | null; messages: Record<string, unknown>[] } {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      // Tool results are user-role blocks in the Anthropic dialect.
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : textOf(m.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else {
      for (const p of m.content) blocks.push(toBlock(p));
    }
    for (const tc of m.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && Array.isArray(last.content)) {
      (last.content as unknown[]).push(...blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }

  return { system: systemParts.length ? systemParts.join('\n\n') : null, messages: out };
}

function toBlock(p: ContentPart): Record<string, unknown> {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.type === 'image') {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(p.url);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    return { type: 'image', source: { type: 'url', url: p.url } };
  }
  return { type: 'text', text: '[audio content is not supported by this provider]' };
}

function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

export function mapStopReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}
