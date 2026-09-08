/**
 * Counting what a request will cost in tokens, before it is sent.
 *
 * Everything here is an **estimate**, and callers are expected to treat it as
 * one: real accounting always uses the counts the provider reports back. The
 * estimate exists to answer questions that have to be answered *before* the
 * call — does this fit the model's window, does it fit the budget, which part
 * of the prompt is the expensive part — and being roughly right in advance is
 * worth more there than being exactly right afterwards.
 *
 * Two things it does that the character heuristic it replaces did not:
 *
 * - **Images are not free.** The router previously read a message list with
 *   `typeof content === 'string' ? content : ''`, so a request carrying ten
 *   screenshots estimated as zero tokens, fitted any context window and
 *   cleared any budget. An image is the single densest thing a prompt can
 *   carry and estimating it at nothing is the worst available answer.
 * - **Structure counts.** Tool schemas, role framing and message envelopes are
 *   real tokens that arrive on the wire, and a budget that ignores them is
 *   short by exactly the amount that makes a request fail.
 */
import type { ChatMessage, ContentPart, ToolDefinition } from './types.js';

/**
 * Average characters per token.
 *
 * ~3.7 sits between English prose (~4.2) and source code (~3.2). It is
 * deliberately on the low side: under-counting tokens produces requests that
 * overflow a window, which fails; over-counting produces requests that are a
 * little smaller than they had to be, which merely costs a little headroom.
 */
export const CHARS_PER_TOKEN = 3.7;

/**
 * Per-message framing overhead.
 *
 * Every chat format wraps each message in role markers and separators. The
 * exact count differs per provider; 4 is the long-standing OpenAI figure and
 * is close enough for the others that carrying a per-provider table would be
 * false precision.
 */
export const TOKENS_PER_MESSAGE = 4;

/**
 * What one image costs, when we cannot know the real answer.
 *
 * Providers price images by tiled resolution — a small image can be ~85 tokens
 * and a large one well over 1,500 — and the URL in the payload tells us
 * nothing about the dimensions. This is a deliberately mid-to-high estimate:
 * the failure mode of guessing low (a request that overflows the window, or a
 * budget that did not bind) is much worse than guessing high.
 */
export const IMAGE_TOKENS_ESTIMATE = 800;

/** Audio is billed per second and the payload does not state a duration. */
export const AUDIO_TOKENS_ESTIMATE = 400;

/** Characters of a data: URL that are payload rather than prompt. */
const DATA_URL_PREFIX = /^data:[^;,]*(;[^,]*)?,/;

/** Text-only estimate. The base every other function here builds on. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * One content part.
 *
 * A `data:` URL is the image itself, base64-encoded. Its length is a fact
 * about the encoding rather than about what the model will be billed, so it is
 * deliberately *not* run through the character estimate — a 2MB screenshot
 * would otherwise estimate at half a million tokens. A remote URL is even less
 * informative. Both get the flat per-image figure.
 */
export function estimateContentPartTokens(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTextTokens(part.text);
    case 'image':
      return IMAGE_TOKENS_ESTIMATE;
    case 'audio':
      return AUDIO_TOKENS_ESTIMATE;
    default:
      return 0;
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = TOKENS_PER_MESSAGE;
  if (typeof message.content === 'string') {
    total += estimateTextTokens(message.content);
  } else {
    for (const part of message.content) total += estimateContentPartTokens(part);
  }
  // A tool call is serialised as JSON on the wire, name and arguments both.
  for (const call of message.toolCalls ?? []) {
    total += estimateTextTokens(call.name) + estimateTextTokens(JSON.stringify(call.arguments ?? {}));
  }
  if (message.name) total += estimateTextTokens(message.name);
  return total;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * A tool definition as the model sees it.
 *
 * The JSON Schema is the bulk of it, and a schema with long property
 * descriptions can easily cost more than the conversation it is attached to —
 * which is the entire reason tool selection is worth doing.
 */
export function estimateToolTokens(tool: ToolDefinition): number {
  return (
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    estimateTextTokens(JSON.stringify(tool.parameters ?? {}))
  );
}

export function estimateToolsTokens(tools: readonly ToolDefinition[]): number {
  let total = 0;
  for (const t of tools) total += estimateToolTokens(t);
  return total;
}

/** Where a request's input tokens actually go. */
export interface TokenBreakdown {
  system: number;
  conversation: number;
  tools: number;
  images: number;
  audio: number;
  /** Sum of every line above. */
  total: number;
  /** How many images and audio clips the total accounts for. */
  imageCount: number;
  audioCount: number;
}

/**
 * Break a request down by where its tokens come from.
 *
 * The breakdown is the point: "31k tokens" tells an operator nothing they can
 * act on, while "18k of it is tool schemas" tells them exactly what to change.
 * Image and audio tokens are counted twice on purpose — once in the section
 * they belong to and once in their own line — so `total` stays the true sum
 * while the media lines stay readable as "of which".
 */
export function breakdownTokens(input: {
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[];
}): TokenBreakdown {
  let system = 0;
  let conversation = 0;
  let images = 0;
  let audio = 0;
  let imageCount = 0;
  let audioCount = 0;

  for (const m of input.messages) {
    const cost = estimateMessageTokens(m);
    if (m.role === 'system') system += cost;
    else conversation += cost;

    if (typeof m.content !== 'string') {
      for (const part of m.content) {
        if (part.type === 'image') {
          images += IMAGE_TOKENS_ESTIMATE;
          imageCount += 1;
        } else if (part.type === 'audio') {
          audio += AUDIO_TOKENS_ESTIMATE;
          audioCount += 1;
        }
      }
    }
  }

  const tools = estimateToolsTokens(input.tools ?? []);
  return { system, conversation, tools, images, audio, total: system + conversation + tools, imageCount, audioCount };
}

/**
 * Prompt-token estimate for a routing request.
 *
 * Accepts the loose shape the router works with — a bare prompt string, a
 * message list, or both — because a routing request may be either and the
 * cost question is the same.
 */
export function estimatePromptTokens(req: {
  prompt?: string | null;
  messages?: readonly ChatMessage[] | null;
  tools?: readonly ToolDefinition[] | null;
}): number {
  let total = 0;
  if (req.prompt) total += estimateTextTokens(req.prompt);
  if (req.messages?.length) total += estimateMessagesTokens(req.messages);
  if (req.tools?.length) total += estimateToolsTokens(req.tools);
  return total;
}

/** Strip the `data:...;base64,` preamble so only the payload is measured. */
export function dataUrlPayloadLength(url: string): number {
  const match = DATA_URL_PREFIX.exec(url);
  return match ? url.length - match[0].length : url.length;
}
