import type { FastifyInstance, FastifyReply } from 'fastify';
import { MeridianError, type ChatMessage, type ContentPart, type ToolDefinition } from '@meridian/shared';
import { beginSse } from './shared.js';
import { requireScope } from './authz.js';
import type { App } from '../services/app.js';
import { buildAIRequest, routingMeta } from './openai.js';
import { withSkills } from './shared.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
}

interface AnthropicBody {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: { role: string; content: string | AnthropicBlock[] }[];
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
  tool_choice?: { type?: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  meridian?: Parameters<typeof buildAIRequest>[0]['meridian'];
}

/**
 * The Anthropic-compatible surface.
 *
 * Claude Code and every other Messages-API client can point at
 * `http://localhost:4639/anthropic` and route through Meridian to *any* model,
 * not just Anthropic's — which is the whole point of putting this dialect
 * alongside the OpenAI one.
 */
export async function registerAnthropicRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.post<{ Body: AnthropicBody }>('/anthropic/v1/messages', { bodyLimit: app.config.maxBodyBytes }, async (req, reply) => {
    requireScope(req, 'inference');
    const body = req.body ?? {};
    const messages = toMessages(body);
    if (!messages.length) throw new MeridianError('invalid_request', '"messages" must contain at least one message');

    const aiRequest = buildAIRequest(body, messages, req.auth.userId, 'text');
    // Same control-plane resolution as the OpenAI surface: whichever skills
    // are configured for this model reach the model on this request.
    const withSkill = withSkills(app, messages, {
      profileId: body.meridian?.profile_id ?? null,
      modelId: aiRequest.model,
      workspaceId: aiRequest.workspaceId,
    });
    const completion = {
      messages: withSkill.messages,
      tools: toTools(body.tools),
      toolChoice: toToolChoice(body.tool_choice),
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens ?? 4096,
      stop: body.stop_sequences,
    };

    if (body.stream) return streamMessages(reply, app, aiRequest, completion, req.requestId);

    const res = await app.executor.chat(aiRequest, completion, { requestId: req.requestId });
    const value = res.value;
    const content: AnthropicBlock[] = [];
    if (value.content) content.push({ type: 'text', text: value.content });
    for (const t of value.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments });

    return {
      id: value.id,
      type: 'message',
      role: 'assistant',
      model: `${res.providerId}:${res.modelId}`,
      content,
      stop_reason: toStopReason(value.finishReason),
      stop_sequence: null,
      usage: { input_tokens: value.usage.promptTokens, output_tokens: value.usage.completionTokens },
      meridian: routingMeta(res, req.requestId),
    };
  });

  /** Token counting, so a client can budget before it sends. */
  server.post<{ Body: AnthropicBody }>('/anthropic/v1/messages/count_tokens', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    const messages = toMessages(req.body ?? {});
    const text = messages.map((m) => (typeof m.content === 'string' ? m.content : partsText(m.content))).join('\n');
    const { estimateTokens } = await import('@meridian/shared');
    return {
      input_tokens: estimateTokens(text),
      meridian: { estimated: true, note: 'Counted with a character heuristic; the serving model reports the exact count.' },
    };
  });

  server.get('/anthropic/v1/models', async () => {
    const models = app.models.all().filter((m) => m.modalities.includes('text'));
    return {
      data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: new Date(m.updatedAt).toISOString() })),
      has_more: false,
    };
  });
}

/* ------------------------------------------------------------------ */

async function streamMessages(
  reply: FastifyReply,
  app: App,
  aiRequest: Parameters<App['executor']['chatStream']>[0],
  completion: Parameters<App['executor']['chatStream']>[1],
  requestId: string,
): Promise<void> {
  beginSse(reply, { 'x-request-id': requestId });

  // The Anthropic stream is a typed event sequence, not bare deltas: clients
  // read `event:` as well as `data:`, so both must be emitted.
  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  reply.raw.on('close', () => ac.abort(new Error('client disconnected')));

  const messageId = `msg_${requestId}`;
  let model = 'auto';
  let started = false;
  let textBlockOpen = false;
  let blockIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  try {
    for await (const chunk of app.executor.chatStream(aiRequest, completion, { requestId, signal: ac.signal })) {
      switch (chunk.type) {
        case 'start':
          // A pre-token fallback re-enters the stream with a second start
          // chunk. The Anthropic contract allows exactly one message_start per
          // message, so only the first opens the message; a retry updates the
          // model silently and the client never sees the seam.
          if (started) {
            model = `${chunk.providerId}:${chunk.model}`;
            break;
          }
          started = true;
          model = `${chunk.providerId}:${chunk.model}`;
          send('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
              meridian: { request_id: requestId, routing: chunk.meta?.routingReason },
            },
          });
          break;
        case 'text':
          if (!textBlockOpen) {
            send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            textBlockOpen = true;
          }
          send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: chunk.delta } });
          break;
        case 'tool_call': {
          if (textBlockOpen) {
            send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            textBlockOpen = false;
            blockIndex += 1;
          }
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: chunk.toolCall.id, name: chunk.toolCall.name, input: {} },
          });
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(chunk.toolCall.arguments) },
          });
          send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex += 1;
          stopReason = 'tool_use';
          break;
        }
        case 'usage':
          inputTokens = chunk.usage.promptTokens;
          outputTokens = chunk.usage.completionTokens;
          break;
        case 'done':
          if (textBlockOpen) {
            send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            textBlockOpen = false;
          }
          if (chunk.finishReason === 'length') stopReason = 'max_tokens';
          else if (chunk.finishReason === 'tool_calls') stopReason = 'tool_use';
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          send('message_stop', { type: 'message_stop' });
          break;
        case 'error':
          send('error', { type: 'error', error: { type: chunk.code, message: chunk.error } });
          break;
      }
    }
  } catch (e) {
    send('error', { type: 'error', error: { type: 'internal', message: e instanceof Error ? e.message : String(e) } });
  } finally {
    reply.raw.end();
  }
}

/* ------------------------------------------------------------------ */

function toMessages(body: AnthropicBody): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (body.system) {
    out.push({ role: 'system', content: typeof body.system === 'string' ? body.system : blocksText(body.system) });
  }
  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      out.push({ role, content: m.content });
      continue;
    }
    const parts: ContentPart[] = [];
    const toolCalls: NonNullable<ChatMessage['toolCalls']> = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text != null) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data ?? ''}` : (b.source.url ?? '');
        if (url) parts.push({ type: 'image', url });
      } else if (b.type === 'tool_use' && b.name) {
        toolCalls.push({ id: b.id ?? 'call', name: b.name, arguments: b.input ?? {} });
      } else if (b.type === 'tool_result') {
        // A tool result arrives inside a user message; the neutral shape gives
        // it its own role, so it is split out here.
        out.push({
          role: 'tool',
          toolCallId: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : blocksText(b.content ?? []),
        });
      }
    }
    if (parts.length || toolCalls.length) {
      out.push({ role, content: parts.length ? parts : '', toolCalls: toolCalls.length ? toolCalls : undefined });
    }
  }
  return out;
}

function toTools(raw: AnthropicBody['tools']): ToolDefinition[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } }));
}

function toToolChoice(raw: AnthropicBody['tool_choice']): 'auto' | 'none' | 'required' | { name: string } | undefined {
  if (!raw?.type) return undefined;
  if (raw.type === 'any') return 'required';
  if (raw.type === 'none') return 'none';
  if (raw.type === 'tool' && raw.name) return { name: raw.name };
  return 'auto';
}

function toStopReason(finish: string): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function blocksText(blocks: AnthropicBlock[]): string {
  return blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');
}

function partsText(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}
