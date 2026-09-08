/**
 * Deciding which optional material a request actually needs.
 *
 * Skills and tool schemas are the two things most likely to be attached "just
 * in case" and then serialised on every single call. Twelve skills at 3k tokens
 * each is a 36k prefix on a request that needed one of them.
 *
 * ## Why this is lexical, and why that is stated plainly
 *
 * The scoring below is term overlap: shared vocabulary between the request and
 * the candidate, weighted toward rarer words. It is not semantic. It will not
 * connect "make the button bigger" to a skill about typography scales unless
 * they share words.
 *
 * That is a deliberate trade rather than an oversight. The alternative —
 * embedding every skill and every request — costs a model call per request to
 * decide what to put in the request, and an optimiser that spends more than it
 * saves is a loss no matter how elegant. This runs in microseconds on strings
 * already in memory.
 *
 * The consequence is that it must be **biased toward inclusion**. A wrongly
 * included skill costs tokens; a wrongly excluded one costs the answer. Every
 * threshold here is set accordingly, and anything the operator asked for
 * explicitly bypasses scoring completely.
 */

/** Words too common to say anything about what a request is about. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'need', 'not', 'of', 'on', 'or', 'please', 'should',
  'so', 'that', 'the', 'then', 'there', 'these', 'this', 'to', 'up', 'use', 'want', 'was', 'we', 'what', 'when',
  'where', 'which', 'will', 'with', 'would', 'you', 'your',
]);

/** Split text into comparable terms: lowercase, de-punctuated, stop-words out. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const t = raw.replace(/^[.\-]+|[.\-]+$/g, '');
    if (t.length < 3 || STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export interface RelevanceCandidate {
  id: string;
  /** Text that describes what this is for: a name, a description, keywords. */
  text: string;
  /** Cost of including it, so a large candidate has to earn its place. */
  estimatedTokens: number;
  /** The operator asked for this by name. Never scored, never dropped. */
  pinned?: boolean;
}

export interface RelevanceVerdict {
  id: string;
  included: boolean;
  score: number;
  /** Why it was included or excluded, in words a UI can show verbatim. */
  reason: string;
}

/**
 * Overlap score in [0,1].
 *
 * Jaccard-style but asymmetric: divided by the *request's* term count, so a
 * long skill document is not penalised for containing many words the request
 * did not use. What matters is how much of the request this candidate speaks to.
 */
export function overlapScore(requestTerms: Set<string>, candidateText: string): number {
  if (requestTerms.size === 0) return 0;
  const candidate = terms(candidateText);
  if (candidate.size === 0) return 0;
  let shared = 0;
  for (const t of requestTerms) if (candidate.has(t)) shared += 1;
  return shared / requestTerms.size;
}

/**
 * A candidate must speak to at least this much of the request to be included
 * on relevance alone.
 *
 * Low on purpose. At 0.08 a single meaningful shared term in a short request is
 * usually enough, which is the right bias when a false exclusion costs the
 * answer and a false inclusion costs a few hundred tokens.
 */
export const RELEVANCE_THRESHOLD = 0.08;

/**
 * Candidates below this token cost skip scoring entirely.
 *
 * Deciding whether to include 150 tokens is not worth the risk of deciding
 * wrongly. This is the same principle as the optimiser bypassing small prompts:
 * effort should be proportional to what is at stake.
 */
export const ALWAYS_INCLUDE_UNDER_TOKENS = 200;

export interface SelectionResult {
  included: string[];
  excluded: string[];
  verdicts: RelevanceVerdict[];
  tokensSaved: number;
}

/**
 * Choose which candidates to include for a request.
 *
 * Order of precedence, strongest first: pinned by the operator, cheap enough
 * not to matter, relevant by overlap, otherwise excluded.
 */
export function select(request: string, candidates: RelevanceCandidate[]): SelectionResult {
  const requestTerms = terms(request);
  const verdicts: RelevanceVerdict[] = [];
  const included: string[] = [];
  const excluded: string[] = [];
  let tokensSaved = 0;

  for (const c of candidates) {
    const score = overlapScore(requestTerms, c.text);

    if (c.pinned) {
      included.push(c.id);
      verdicts.push({ id: c.id, included: true, score, reason: 'you enabled it explicitly, so it is always included' });
      continue;
    }
    if (c.estimatedTokens <= ALWAYS_INCLUDE_UNDER_TOKENS) {
      included.push(c.id);
      verdicts.push({
        id: c.id,
        included: true,
        score,
        reason: `small enough (${c.estimatedTokens} tokens) that leaving it out would not be worth the risk`,
      });
      continue;
    }
    if (score >= RELEVANCE_THRESHOLD) {
      included.push(c.id);
      verdicts.push({
        id: c.id,
        included: true,
        score,
        reason: `shares ${Math.round(score * 100)}% of the request's distinctive terms`,
      });
      continue;
    }
    excluded.push(c.id);
    tokensSaved += c.estimatedTokens;
    verdicts.push({
      id: c.id,
      included: false,
      score,
      reason:
        score > 0
          ? `only ${Math.round(score * 100)}% term overlap with this request, below the ${Math.round(RELEVANCE_THRESHOLD * 100)}% bar`
          : 'nothing in this request refers to what it covers',
    });
  }

  return { included, excluded, verdicts, tokensSaved };
}
