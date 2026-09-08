/**
 * The individual things an optimiser is allowed to do to a message list.
 *
 * Each transform is pure, independently testable, and reports what it changed.
 * That last part is not decoration: a "tokens saved" figure produced by the
 * same pass that did the trimming is unfalsifiable unless each step can say
 * exactly which blocks it touched and why.
 *
 * Every transform obeys one rule. **User messages are never removed and never
 * altered.** What the user said is the task; a smaller prompt that lost part of
 * it is not an optimisation, it is a different request.
 */
import { createHash } from 'node:crypto';
import { estimateMessageTokens, type ChatMessage } from '@meridian/shared';
import { extractRequirements } from './safety.js';

export interface TransformNote {
  /** Which transform did this. */
  stage: string;
  /** What it did, in words that would make sense in a UI. */
  detail: string;
  /** Estimated tokens removed. Never negative. */
  tokensSaved: number;
}

export interface TransformResult {
  messages: ChatMessage[];
  notes: TransformNote[];
}

/** Content long enough that repeating it is worth spending a hash on. */
const MIN_DEDUPE_CHARS = 200;

/**
 * The concrete things a message names, which must not be lost with it.
 *
 * Shares its definition with the safety check on purpose: the set a transform
 * has to preserve and the set the checker looks for must be the same set, or
 * the two drift and the check starts passing things it should not.
 */
function extractReferences(text: string): Set<string> {
  return extractRequirements(text);
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
}

/**
 * A stable fingerprint for a block of text.
 *
 * Whitespace-normalised so that the same file printed twice with different
 * indentation still counts as the same content — which is exactly what happens
 * when an agent reads a file, and then reads it again after an edit that
 * changed nothing it cares about.
 */
export function blockHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/**
 * Remove content that is already in the prompt verbatim.
 *
 * The safest possible saving: nothing unique is lost, because by definition the
 * content survives at its other occurrence. The *later* copy is kept rather
 * than the earlier one — in an agent loop the newest read is the current truth,
 * and a stale earlier copy of a file that has since been edited is worse than
 * no copy at all.
 *
 * Only tool results and assistant messages are eligible. A system message
 * repeating itself is usually two different instructions that happen to match,
 * and user messages are never touched.
 */
export function deduplicate(messages: ChatMessage[]): TransformResult {
  const notes: TransformNote[] = [];
  const lastIndexByHash = new Map<string, number>();

  messages.forEach((m, i) => {
    if (m.role !== 'tool' && m.role !== 'assistant') return;
    const text = textOf(m);
    if (text.length < MIN_DEDUPE_CHARS) return;
    lastIndexByHash.set(blockHash(text), i);
  });

  const out: ChatMessage[] = [];
  let duplicates = 0;
  let saved = 0;

  messages.forEach((m, i) => {
    if (m.role !== 'tool' && m.role !== 'assistant') {
      out.push(m);
      return;
    }
    const text = textOf(m);
    if (text.length < MIN_DEDUPE_CHARS) {
      out.push(m);
      return;
    }
    const hash = blockHash(text);
    if (lastIndexByHash.get(hash) === i) {
      out.push(m);
      return;
    }
    // A marker rather than deletion: the model needs to know the step happened,
    // and a tool message that vanishes leaves an assistant tool_call answered by
    // nothing, which some providers reject outright.
    const replacement: ChatMessage = {
      ...m,
      content: `[identical content appears later in this conversation; omitted here to save ${estimateMessageTokens(m)} tokens]`,
    };
    saved += Math.max(0, estimateMessageTokens(m) - estimateMessageTokens(replacement));
    duplicates += 1;
    out.push(replacement);
  });

  if (duplicates > 0) {
    notes.push({
      stage: 'deduplicate',
      detail: `${duplicates} block${duplicates === 1 ? '' : 's'} repeated content that appears later in the prompt`,
      tokensSaved: saved,
    });
  }
  return { messages: out, notes };
}

/** How much of an elided tool result to keep, so it stays recognisable. */
const TOOL_RESULT_PREVIEW_CHARS = 240;

/**
 * Shorten tool results the conversation has moved past.
 *
 * In a long agent run this is where the tokens are: forty turns of 40 KB tool
 * output, re-sent whole on every single turn. The most recent results are the
 * ones being reasoned about and keep their full body; older ones keep a
 * recognisable head and a note of what was dropped, so the model can still see
 * that it ran the command and what it was looking at.
 */
export function elideStaleToolResults(messages: ChatMessage[], keepRecent: number): TransformResult {
  const notes: TransformNote[] = [];
  if (!Number.isFinite(keepRecent)) return { messages, notes };

  const toolIndices = messages.reduce<number[]>((acc, m, i) => {
    if (m.role === 'tool') acc.push(i);
    return acc;
  }, []);
  const protectedFrom = Math.max(0, toolIndices.length - Math.max(0, keepRecent));
  const stale = new Set(toolIndices.slice(0, protectedFrom));
  if (!stale.size) return { messages, notes };

  let elided = 0;
  let saved = 0;
  const out = messages.map((m, i) => {
    if (!stale.has(i)) return m;
    const text = textOf(m);
    if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return m;
    const replacement: ChatMessage = {
      ...m,
      content: `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n\n[…${(text.length - TOOL_RESULT_PREVIEW_CHARS).toLocaleString()} more characters from an earlier step, omitted. Re-run the tool if you need them.]`,
    };
    saved += Math.max(0, estimateMessageTokens(m) - estimateMessageTokens(replacement));
    elided += 1;
    return replacement;
  });

  if (elided > 0) {
    notes.push({
      stage: 'elide-tool-results',
      detail: `shortened ${elided} tool result${elided === 1 ? '' : 's'} from earlier steps, keeping the ${keepRecent} most recent in full`,
      tokensSaved: saved,
    });
  }
  return { messages: out, notes };
}

/**
 * Drop turns from the middle of a long conversation.
 *
 * Three things are anchored and never dropped:
 *
 * - **Every system message.** These are the instructions.
 * - **The first user message.** In an agent run that is the task itself, and
 *   losing it is how a model twenty turns deep forgets what it was asked to do.
 * - **The most recent turns.** This is where the current work is.
 *
 * What goes is the middle, replaced by a note saying how much was removed. That
 * note is deliberately not a summary: summarising would need a model call, and
 * a fabricated summary of dropped content is worse than an honest gap.
 */
export function windowHistory(messages: ChatMessage[], keepRecentTurns: number): TransformResult {
  const notes: TransformNote[] = [];
  if (!Number.isFinite(keepRecentTurns)) return { messages, notes };

  const keep = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === 'system') keep.add(i);
  });
  const firstUser = messages.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) keep.add(firstUser);
  for (let i = Math.max(0, messages.length - keepRecentTurns); i < messages.length; i += 1) keep.add(i);

  const droppedIndices = messages.map((_, i) => i).filter((i) => !keep.has(i));
  if (!droppedIndices.length) return { messages, notes };

  // An assistant message carrying tool calls has to keep the tool messages that
  // answer it: dropping half of that pair leaves a dangling call that some
  // providers reject and every model finds confusing.
  const pinned = new Set<number>();
  for (const i of droppedIndices) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const answers = messages
        .map((x, j) => ({ x, j }))
        .filter(({ x, j }) => j > i && x.role === 'tool' && m.toolCalls?.some((c) => c.id === x.toolCallId));
      if (answers.some(({ j }) => keep.has(j))) pinned.add(i);
    }
    if (m.role === 'tool' && m.toolCallId) {
      const callIndex = messages.findIndex((x) => x.role === 'assistant' && x.toolCalls?.some((c) => c.id === m.toolCallId));
      if (callIndex >= 0 && keep.has(callIndex)) pinned.add(i);
    }
  }

  const finalDropped = droppedIndices.filter((i) => !pinned.has(i));
  if (!finalDropped.length) return { messages, notes };

  const dropped = new Set(finalDropped);
  let saved = 0;
  for (const i of dropped) saved += estimateMessageTokens(messages[i]);

  // Anything the dropped turns named — a filename, an identifier, a quoted
  // string — is carried into the marker rather than going with them. Losing the
  // prose of an old turn is ordinary; losing the fact that the user said
  // "in `src/db/users.ts`" twenty turns ago changes what the request means, and
  // hoisting the references is what lets a long conversation be windowed at all
  // without the safety check refusing the whole pass.
  const carried = new Set<string>();
  for (const i of dropped) {
    if (messages[i].role !== 'user') continue;
    for (const ref of extractReferences(textOf(messages[i]))) carried.add(ref);
  }

  const out: ChatMessage[] = [];
  let markerPlaced = false;
  messages.forEach((m, i) => {
    if (!dropped.has(i)) {
      out.push(m);
      return;
    }
    if (!markerPlaced) {
      const references = carried.size
        ? ` They referred to: ${[...carried].join(', ')}.`
        : '';
      const marker: ChatMessage = {
        role: 'system',
        content: `[${dropped.size} earlier message${dropped.size === 1 ? '' : 's'} from the middle of this conversation were omitted to fit the context window. The original request and the most recent exchanges are intact.${references}]`,
      };
      saved -= estimateMessageTokens(marker);
      out.push(marker);
      markerPlaced = true;
    }
  });

  notes.push({
    stage: 'window-history',
    detail: `dropped ${dropped.size} message${dropped.size === 1 ? '' : 's'} from the middle, keeping the system prompt, the original request and the last ${keepRecentTurns} turns`,
    tokensSaved: Math.max(0, saved),
  });
  return { messages: out, notes };
}
