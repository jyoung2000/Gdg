import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  MeridianError,
  isFree,
  type AIRequest,
  type ChatMessage,
  type ContentPart,
  type Modality,
  type RoutingMode,
  type ToolDefinition,
} from '@meridian/shared';
import { beginSse } from './shared.js';
import type { App } from '../services/app.js';

interface OAIMessage {
  role: string;
  content?: string | { type: string; text?: string; image_url?: { url: string }; input_audio?: { data: string; format?: string } }[] | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface OAIChatBody {
  model?: string;
  messages?: OAIMessage[];
  tools?: { type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  response_format?: { type?: string; json_schema?: { schema?: Record<string, unknown> } };
  user?: string;
  /**
   * Meridian extensions. Namespaced so a stock OpenAI client is unaffected and
   * a Meridian-aware client gets the routing controls.
   */
  meridian?: {
    mode?: RoutingMode;
    pool?: string;
    provider?: string;
    free_only?: boolean;
    local_only?: boolean;
    allow_paid?: boolean;
    budget?: number;
    sensitive?: boolean;
    task_type?: AIRequest['taskType'];
    workspace_id?: string;
  };
}

/**
 * The OpenAI-compatible surface.
 *
 * Compatibility is the point: any client that speaks the OpenAI dialect —
 * an SDK, a coding agent, a shell script — works against Meridian unchanged and
 * gains routing, fallback and cost accounting without knowing they exist. The
 * `meridian` extension object is how a client that *does* know can steer.
 */
export async function registerOpenAIRoutes(server: FastifyInstance, app: App): Promise<void> {
  /* ---- Models ---------------------------------------------------- */

  server.get('/v1/models', async (req) => {
    const models = app.models.all().filter((m) => app.providers.supportState(m.providerId) !== 'unavailable');
    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(m.updatedAt / 1000),
        owned_by: m.providerId,
        // Extra fields are ignored by strict clients and invaluable to ours.
        meridian: {
          display_name: m.displayName,
          provider: m.providerId,
          modalities: m.modalities,
          capabilities: m.capabilities,
          context_length: m.contextLength,
          pricing_kind: m.pricing.kind,
          free: isFree(m.pricing),
          status: app.models.getStatus(m.id),
        },
      })),
      meridian: { request_id: req.requestId, total: models.length },
    };
  });

  server.get<{ Params: { '*': string } }>('/v1/models/*', async (req) => {
    const id = req.params['*'];
    const matches = app.models.resolve(id);
    if (!matches.length) throw new MeridianError('model_unavailable', `No model matches "${id}"`, { modelId: id });
    const m = matches[0];
    return { id: m.id, object: 'model', created: Math.floor(m.updatedAt / 1000), owned_by: m.providerId };
  });

  /* ---- Chat completions ------------------------------------------ */

  server.post<{ Body: OAIChatBody }>('/v1/chat/completions', { bodyLimit: app.config.maxBodyBytes }, async (req, reply) => {
    const body = req.body ?? {};
    const messages = toChatMessages(body.messages ?? []);
    if (!messages.length) throw new MeridianError('invalid_request', '"messages" must contain at least one message');

    const aiRequest = buildAIRequest(body, messages, req.auth.userId, 'text');
    const completion = {
      messages,
      tools: toToolDefinitions(body.tools),
      toolChoice: normaliseToolChoice(body.tool_choice),
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      stop: typeof body.stop === 'string' ? [body.stop] : body.stop,
      responseFormat: toResponseFormat(body.response_format),
    };

    if (body.stream) {
      return streamChat(reply, app, aiRequest, completion, req.requestId, body.model ?? 'auto');
    }

    const res = await app.executor.chat(aiRequest, completion, { requestId: req.requestId });
    const value = res.value;
    return {
      id: value.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${res.providerId}:${res.modelId}`,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: value.content || null,
            ...(value.toolCalls.length
              ? {
                  tool_calls: value.toolCalls.map((t) => ({
                    id: t.id,
                    type: 'function',
                    function: { name: t.name, arguments: JSON.stringify(t.arguments) },
                  })),
                }
              : {}),
          },
          finish_reason: value.finishReason,
        },
      ],
      usage: {
        prompt_tokens: value.usage.promptTokens,
        completion_tokens: value.usage.completionTokens,
        total_tokens: value.usage.totalTokens,
      },
      meridian: routingMeta(res, req.requestId),
    };
  });

  /* ---- Responses API --------------------------------------------- */

  server.post<{ Body: OAIChatBody & { input?: string | OAIMessage[]; instructions?: string; max_output_tokens?: number } }>('/v1/responses', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    const body = req.body ?? {};
    const messages: ChatMessage[] = [];
    if (body.instructions) messages.push({ role: 'system', content: body.instructions });
    if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
    else if (Array.isArray(body.input)) messages.push(...toChatMessages(body.input));
    else if (body.messages) messages.push(...toChatMessages(body.messages));
    if (!messages.length) throw new MeridianError('invalid_request', 'Provide "input" or "messages"');

    const res = await app.executor.chat(
      buildAIRequest(body, messages, req.auth.userId, 'text'),
      { messages, tools: toToolDefinitions(body.tools), maxTokens: body.max_output_tokens ?? body.max_tokens, temperature: body.temperature },
      { requestId: req.requestId },
    );
    return {
      id: res.value.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: `${res.providerId}:${res.modelId}`,
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: res.value.content }],
        },
      ],
      output_text: res.value.content,
      usage: {
        input_tokens: res.value.usage.promptTokens,
        output_tokens: res.value.usage.completionTokens,
        total_tokens: res.value.usage.totalTokens,
      },
      meridian: routingMeta(res, req.requestId),
    };
  });

  /* ---- Embeddings ------------------------------------------------- */

  server.post<{ Body: { model?: string; input?: string | string[]; meridian?: OAIChatBody['meridian'] } }>('/v1/embeddings', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    const body = req.body ?? {};
    const input = typeof body.input === 'string' ? [body.input] : (body.input ?? []);
    if (!input.length) throw new MeridianError('invalid_request', '"input" is required');

    const res = await app.executor.embed(
      buildAIRequest(body, [], req.auth.userId, 'embedding', 'embedding'),
      { input },
      { requestId: req.requestId },
    );
    return {
      object: 'list',
      data: res.value.embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: `${res.providerId}:${res.modelId}`,
      usage: { prompt_tokens: res.value.usage.promptTokens, total_tokens: res.value.usage.totalTokens },
      meridian: routingMeta(res, req.requestId),
    };
  });

  /* ---- Images ----------------------------------------------------- */

  server.post<{
    Body: { model?: string; prompt?: string; n?: number; size?: string; negative_prompt?: string; seed?: number; meridian?: OAIChatBody['meridian'] };
  }>('/v1/images/generations', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    const body = req.body ?? {};
    if (!body.prompt) throw new MeridianError('invalid_request', '"prompt" is required');
    const [width, height] = parseSize(body.size);

    const res = await app.executor.image(
      buildAIRequest(body, [], req.auth.userId, 'image', 'image-generation'),
      { prompt: body.prompt, negativePrompt: body.negative_prompt, n: body.n ?? 1, width, height, seed: body.seed ?? null },
      { requestId: req.requestId, timeoutMs: 180_000 },
    );
    return {
      created: Math.floor(Date.now() / 1000),
      data: res.value.assets.map((a) => (a.url.startsWith('data:') ? { b64_json: a.url.slice(a.url.indexOf(',') + 1) } : { url: a.url })),
      meridian: routingMeta(res, req.requestId),
    };
  });

  /* ---- Audio ------------------------------------------------------ */

  server.post<{ Body: { model?: string; input?: string; voice?: string; response_format?: string; speed?: number; meridian?: OAIChatBody['meridian'] } }>(
    '/v1/audio/speech', { bodyLimit: app.config.maxBodyBytes },
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.input) throw new MeridianError('invalid_request', '"input" is required');
      const res = await app.executor.speech(
        buildAIRequest(body, [], req.auth.userId, 'speech', 'speech-synthesis'),
        {
          text: body.input,
          voice: body.voice,
          format: (body.response_format as 'mp3' | 'wav' | 'opus' | 'flac' | undefined) ?? 'mp3',
          speed: body.speed,
        },
        { requestId: req.requestId, timeoutMs: 120_000 },
      );
      const asset = res.value.asset;
      const comma = asset.url.indexOf(',');
      // The OpenAI contract is raw audio bytes, not JSON.
      const bytes = asset.url.startsWith('data:') ? Buffer.from(asset.url.slice(comma + 1), 'base64') : Buffer.alloc(0);
      reply
        .header('content-type', asset.mimeType)
        .header('x-meridian-model', `${res.providerId}:${res.modelId}`)
        .send(bytes);
    },
  );

  server.post<{ Body: { model?: string; file?: string; mime_type?: string; language?: string; prompt?: string; meridian?: OAIChatBody['meridian'] } }>(
    '/v1/audio/transcriptions', { bodyLimit: app.config.maxBodyBytes },
    async (req) => {
      const body = req.body ?? {};
      // Multipart would need another plugin and a temp-file policy; a base64
      // field keeps the surface to JSON and is what our own client sends.
      if (!body.file) throw new MeridianError('invalid_request', '"file" must be base64-encoded audio (or a data: URL)');
      const raw = body.file.startsWith('data:') ? body.file.slice(body.file.indexOf(',') + 1) : body.file;
      const audio = new Uint8Array(Buffer.from(raw, 'base64'));

      const res = await app.executor.transcribe(
        buildAIRequest(body, [], req.auth.userId, 'transcription', 'transcription'),
        { audio, mimeType: body.mime_type ?? 'audio/mpeg', language: body.language, prompt: body.prompt },
        { requestId: req.requestId, timeoutMs: 300_000 },
      );
      return { text: res.value.text, language: res.value.language, meridian: routingMeta(res, req.requestId) };
    },
  );
}

/* ------------------------------------------------------------------ */
/* Streaming                                                          */
/* ------------------------------------------------------------------ */

async function streamChat(
  reply: FastifyReply,
  app: App,
  aiRequest: AIRequest,
  completion: Parameters<App['executor']['chat']>[1],
  requestId: string,
  requestedModel: string,
): Promise<void> {
  beginSse(reply, { 'x-request-id': requestId });

  const id = `chatcmpl-${requestId}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (payload: unknown): void => {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // A client that disconnects mid-stream should stop the upstream call too,
  // otherwise an abandoned tab keeps spending tokens.
  const ac = new AbortController();
  reply.raw.on('close', () => ac.abort(new Error('client disconnected')));

  let model = requestedModel;
  try {
    for await (const chunk of app.executor.chatStream(aiRequest, completion, { requestId, signal: ac.signal })) {
      switch (chunk.type) {
        case 'start':
          model = `${chunk.providerId}:${chunk.model}`;
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            meridian: { request_id: requestId, routing: chunk.meta?.routingReason },
          });
          break;
        case 'text':
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }] });
          break;
        case 'tool_call':
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: chunk.toolCall.id, type: 'function', function: { name: chunk.toolCall.name, arguments: JSON.stringify(chunk.toolCall.arguments) } },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          break;
        case 'usage':
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: chunk.usage.promptTokens,
              completion_tokens: chunk.usage.completionTokens,
              total_tokens: chunk.usage.totalTokens,
            },
            meridian: { cost: chunk.usage.cost },
          });
          break;
        case 'done':
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: chunk.finishReason }] });
          break;
        case 'error':
          send({ error: { code: chunk.code, message: chunk.error } });
          break;
      }
    }
  } catch (e) {
    send({ error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } });
  } finally {
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }
}

/* ------------------------------------------------------------------ */
/* Translation                                                        */
/* ------------------------------------------------------------------ */

export function toChatMessages(raw: OAIMessage[]): ChatMessage[] {
  return raw.map((m): ChatMessage => {
    const role = (['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : 'user') as ChatMessage['role'];
    let content: string | ContentPart[];
    if (typeof m.content === 'string' || m.content == null) {
      content = m.content ?? '';
    } else {
      content = m.content.map((p): ContentPart => {
        if (p.type === 'image_url' && p.image_url) return { type: 'image', url: p.image_url.url };
        if (p.type === 'input_audio' && p.input_audio) return { type: 'audio', url: p.input_audio.data, mimeType: p.input_audio.format };
        return { type: 'text', text: p.text ?? '' };
      });
    }
    return {
      role,
      content,
      toolCalls: m.tool_calls?.length
        ? m.tool_calls.map((t) => ({
            id: t.id ?? 'call',
            name: t.function?.name ?? '',
            arguments: parseArgs(t.function?.arguments),
          }))
        : undefined,
      toolCallId: m.tool_call_id,
      name: m.name,
    };
  });
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toToolDefinitions(raw: OAIChatBody['tools']): ToolDefinition[] | undefined {
  if (!raw?.length) return undefined;
  return raw
    .filter((t) => t.function?.name)
    .map((t) => ({
      name: t.function!.name,
      description: t.function!.description ?? '',
      parameters: t.function!.parameters ?? { type: 'object', properties: {} },
    }));
}

function normaliseToolChoice(raw: unknown): 'auto' | 'none' | 'required' | { name: string } | undefined {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (raw && typeof raw === 'object') {
    const fn = (raw as { function?: { name?: string } }).function;
    if (fn?.name) return { name: fn.name };
  }
  return undefined;
}

function toResponseFormat(raw: OAIChatBody['response_format']): { type: 'text' | 'json_object' | 'json_schema'; schema?: Record<string, unknown> } | undefined {
  if (!raw?.type) return undefined;
  if (raw.type === 'json_schema') return { type: 'json_schema', schema: raw.json_schema?.schema };
  if (raw.type === 'json_object') return { type: 'json_object' };
  return { type: 'text' };
}

function parseSize(size: string | undefined): [number | undefined, number | undefined] {
  if (!size) return [undefined, undefined];
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? [Number(m[1]), Number(m[2])] : [undefined, undefined];
}

/**
 * Build the normalised routing request.
 *
 * `model` is optional here in a way the OpenAI API is not: omitting it — or
 * passing the sentinel "auto" — is how a caller says "you decide", which is the
 * product's default experience.
 */
export function buildAIRequest(
  body: { model?: string; meridian?: OAIChatBody['meridian'] },
  messages: ChatMessage[],
  userId: string | null,
  modality: Modality,
  taskType: AIRequest['taskType'] = 'chat',
): AIRequest {
  const ext = body.meridian ?? {};
  const model = body.model && body.model !== 'auto' && body.model !== 'meridian' ? body.model : null;
  return {
    modality,
    taskType: ext.task_type ?? taskType,
    messages: messages.length ? messages : undefined,
    model,
    provider: ext.provider ?? null,
    pool: ext.pool ?? null,
    mode: ext.mode,
    freeOnly: ext.free_only,
    localOnly: ext.local_only,
    allowPaid: ext.allow_paid,
    budget: ext.budget ?? null,
    sensitive: ext.sensitive,
    userId,
    workspaceId: ext.workspace_id ?? null,
    toolsRequired: false,
  };
}

/** Routing transparency attached to every response. */
export function routingMeta(
  res: { providerId: string; modelId: string; attempts: number; fallbacks: unknown[]; routingReason: unknown; totalLatencyMs: number },
  requestId: string,
): Record<string, unknown> {
  return {
    request_id: requestId,
    provider: res.providerId,
    model: res.modelId,
    attempts: res.attempts,
    fallbacks: res.fallbacks,
    routing: res.routingReason,
    latency_ms: res.totalLatencyMs,
  };
}
