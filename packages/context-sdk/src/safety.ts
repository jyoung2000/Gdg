/**
 * Checking that the smaller prompt still asks the same question.
 *
 * This is the part that makes the rest safe to run. Every transform is written
 * to preserve what matters, but "written to" is not "verified to", and the
 * failure mode of a context optimiser is silent: the request succeeds, the
 * answer is subtly wrong, and nothing anywhere reports a problem. A model
 * cannot tell you that the constraint it was never shown has been violated.
 *
 * So the optimised prompt is compared against the original before it is sent,
 * and anything that fails the comparison causes a **fallback to a less
 * aggressive mode** rather than a warning nobody reads.
 *
 * What is checked is deliberately mechanical — presence of things that can be
 * matched exactly. A semantic check would need a model call, would itself be
 * fallible, and would turn a cheap guarantee into an expensive opinion.
 */
import { type ChatMessage } from '@meridian/shared';

export interface SafetyIssue {
  kind: 'user-text-missing' | 'system-text-missing' | 'requirement-missing' | 'no-user-message';
  detail: string;
}

export interface SafetyVerdict {
  safe: boolean;
  issues: SafetyIssue[];
}

/**
 * Things that read as a hard requirement rather than conversation.
 *
 * A filename, an identifier, a quoted string, a URL, a number with units. These
 * are what a request means in practice — "rename `getUserById` in
 * `src/db/users.ts`" is two tokens of intent and two tokens that must survive
 * verbatim or the answer is about the wrong thing.
 */
const REQUIREMENT_PATTERNS: RegExp[] = [
  /`[^`\n]{2,80}`/g, // backticked identifiers and paths
  /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|yaml|yml|sql|sh|css|html)\b/gi, // filenames
  /\bhttps?:\/\/\S+/gi, // URLs
  /"[^"\n]{3,80}"/g, // quoted strings
];

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** Every distinct requirement-shaped token in a body of text. */
export function extractRequirements(text: string): Set<string> {
  const out = new Set<string>();
  for (const pattern of REQUIREMENT_PATTERNS) {
    for (const match of text.matchAll(pattern)) out.add(match[0]);
  }
  return out;
}

/**
 * Compare an optimised prompt against the original.
 *
 * Four guarantees, in descending order of how catastrophic their loss is:
 *
 * 1. There is still a user message at all.
 * 2. The **first and the most recent** user messages survive byte for byte.
 *    Those two carry the task and the current instruction, and a paraphrase of
 *    either is a different request.
 * 3. Every requirement-shaped token from *any* user message — a filename, an
 *    identifier, a quoted string — is still present somewhere in the prompt.
 * 4. At least one system message survives, if there was one.
 *
 * Point 2 is deliberately not "every user message". Windowing a forty-turn
 * conversation necessarily drops old turns, and a check that forbade it would
 * make history windowing unusable for exactly the conversations that need it —
 * which is what the first version of this did, and the benchmark caught: long
 * chats reported a 0% saving because every attempt fell back.
 *
 * Point 3 is what makes point 2 safe. A turn's prose may go; the concrete
 * things it named may not. `windowHistory` hoists those references into the
 * marker it leaves behind, so the requirement survives even when the sentence
 * around it does not.
 */
export function checkSafety(original: ChatMessage[], optimized: ChatMessage[]): SafetyVerdict {
  const issues: SafetyIssue[] = [];

  const originalUsers = original.filter((m) => m.role === 'user');
  const optimizedUsers = optimized.filter((m) => m.role === 'user');

  if (originalUsers.length > 0 && optimizedUsers.length === 0) {
    issues.push({ kind: 'no-user-message', detail: 'optimisation removed every user message' });
    return { safe: false, issues };
  }

  const optimizedUserText = optimizedUsers.map(textOf);
  const anchors =
    originalUsers.length > 1 ? [originalUsers[0], originalUsers[originalUsers.length - 1]] : originalUsers;
  for (const m of anchors) {
    const text = textOf(m);
    if (!text.trim()) continue;
    if (!optimizedUserText.some((t) => t.includes(text))) {
      issues.push({
        kind: 'user-text-missing',
        detail: `the ${m === originalUsers[0] ? 'original request' : 'most recent instruction'} is missing or altered: ${JSON.stringify(text.slice(0, 80))}`,
      });
    }
  }

  // Requirements may live anywhere in the optimised prompt — a transform is
  // allowed to move a filename from a dropped tool result into a marker, as
  // long as it is still there to be read.
  const wholeOptimized = optimized.map(textOf).join('\n');
  const requirements = new Set<string>();
  for (const m of originalUsers) for (const r of extractRequirements(textOf(m))) requirements.add(r);
  for (const r of requirements) {
    if (!wholeOptimized.includes(r)) {
      issues.push({ kind: 'requirement-missing', detail: `the request named ${r} and the optimised prompt does not contain it` });
    }
  }

  // A system message may be *shortened* by design (that is what the history
  // marker does), but one that vanishes entirely took its instructions with it.
  const originalSystemCount = original.filter((m) => m.role === 'system').length;
  const optimizedSystemCount = optimized.filter((m) => m.role === 'system').length;
  if (originalSystemCount > 0 && optimizedSystemCount === 0) {
    issues.push({ kind: 'system-text-missing', detail: 'optimisation removed every system message' });
  }

  return { safe: issues.length === 0, issues };
}
