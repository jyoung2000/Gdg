/**
 * The pipeline: measure, transform, verify, report.
 *
 * The order is the argument. Measurement comes first so the "before" number is
 * taken from the untouched prompt rather than from the optimiser's own idea of
 * what it started with. Verification comes last and can **undo the whole
 * thing** — a run that cannot prove it preserved the request falls back to a
 * gentler mode rather than shipping a prompt it is not sure about.
 *
 * ## The number this reports
 *
 * `tokensSaved` is `before − after`, both measured by the same estimator over
 * the actual message lists. It is not a sum of what each stage believed it
 * saved: stages interact, and self-reported savings double-count. Those
 * per-stage figures are still reported, as attribution, but the headline number
 * is a subtraction between two real measurements.
 *
 * ## When it declines to run
 *
 * Optimising costs CPU and, more importantly, risk. On a prompt that already
 * fits comfortably there is nothing to win and something to lose, so the
 * pipeline is skipped and says so. An optimiser that always reports a saving is
 * an optimiser that is sometimes making things worse.
 */
import { breakdownTokens, estimateMessagesTokens, type ChatMessage, type ModelDescriptor, type ToolDefinition } from '@meridian/shared';
import { computeBudget, type ContextBudget } from './budget.js';
import { autoMode, policyFor, type OptimizationMode } from './modes.js';
import { deduplicate, elideStaleToolResults, windowHistory, type TransformNote } from './transforms.js';
import { checkSafety, type SafetyIssue } from './safety.js';
import { select, type RelevanceCandidate, type RelevanceVerdict } from './relevance.js';

export interface OptimizeInput {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** The model this is bound for; supplies the window. */
  model?: Pick<ModelDescriptor, 'contextLength' | 'maxOutputTokens'> | null;
  maxOutputTokens?: number | null;
  /** 'AUTO' picks a mode from how full the window already is. */
  mode?: OptimizationMode | 'AUTO';
  /** Optional skills, so selection can happen before they are serialised. */
  skills?: RelevanceCandidate[];
  /** What the user is actually asking, for relevance scoring. */
  request?: string;
}

export interface OptimizationReport {
  /** The mode that actually ran, after AUTO resolution and any fallback. */
  mode: OptimizationMode;
  /** What AUTO chose, before a safety fallback changed it. Null if not AUTO. */
  requestedMode: OptimizationMode | null;
  before: number;
  after: number;
  /** before − after. Zero when nothing ran; never negative. */
  tokensSaved: number;
  /** Share of the original prompt removed, 0..1. */
  savedFraction: number;
  budget: ContextBudget;
  /** Where the original prompt's tokens were. */
  breakdown: ReturnType<typeof breakdownTokens>;
  /** Per-stage attribution. Sums to more than tokensSaved when stages overlap. */
  notes: TransformNote[];
  /** Why each skill was included or left out. */
  skillVerdicts: RelevanceVerdict[];
  /** Populated when a first attempt failed its safety check and was redone. */
  safetyIssues: SafetyIssue[];
  /** True when the pipeline deliberately did nothing, with `reason` saying why. */
  skipped: boolean;
  reason: string;
  /** Wall-clock cost of optimising, so it can be judged against the saving. */
  elapsedMs: number;
}

export interface OptimizeResult {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Skill ids that survived selection, in input order. */
  skills: string[];
  report: OptimizationReport;
}

/**
 * Below this, optimisation is not attempted at all.
 *
 * A prompt of a few hundred tokens has nothing worth taking out, and the risk
 * of a transform mis-firing is constant regardless of size. This is the "do not
 * spend substantial compute deciding how to save a trivial number of tokens"
 * rule, expressed as a number.
 */
export const MIN_TOKENS_TO_OPTIMIZE = 1500;

/** Order modes try when a safety check fails: gentler each time, then nothing. */
const FALLBACK_ORDER: OptimizationMode[] = ['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE', 'OFF'];

function gentler(mode: OptimizationMode): OptimizationMode {
  const i = FALLBACK_ORDER.indexOf(mode);
  return i < 0 || i === FALLBACK_ORDER.length - 1 ? 'OFF' : FALLBACK_ORDER[i + 1];
}

/** Run every transform a mode permits, once. */
function applyMode(messages: ChatMessage[], mode: OptimizationMode): { messages: ChatMessage[]; notes: TransformNote[] } {
  const policy = policyFor(mode);
  const notes: TransformNote[] = [];
  let current = messages;

  if (policy.deduplicate) {
    const r = deduplicate(current);
    current = r.messages;
    notes.push(...r.notes);
  }
  if (policy.elideStaleToolResults) {
    const r = elideStaleToolResults(current, policy.keepRecentToolResults);
    current = r.messages;
    notes.push(...r.notes);
  }
  // History windowing goes last: the transforms above make messages smaller,
  // and running this first would drop turns that would have fitted once the
  // cheap savings had been taken.
  if (policy.windowHistory) {
    const r = windowHistory(current, policy.keepRecentTurns);
    current = r.messages;
    notes.push(...r.notes);
  }
  return { messages: current, notes };
}

export function optimizeContext(input: OptimizeInput): OptimizeResult {
  const startedAt = Date.now();
  const tools = input.tools ?? [];
  const before = estimateMessagesTokens(input.messages) + (tools.length ? breakdownTokens({ messages: [], tools }).tools : 0);
  const breakdown = breakdownTokens({ messages: input.messages, tools });
  const budget = computeBudget({ model: input.model ?? null, usedTokens: before, maxOutputTokens: input.maxOutputTokens });

  const skipReport = (mode: OptimizationMode, reason: string): OptimizeResult => ({
    messages: input.messages,
    tools,
    skills: (input.skills ?? []).map((s) => s.id),
    report: {
      mode,
      requestedMode: input.mode === 'AUTO' ? mode : null,
      before,
      after: before,
      tokensSaved: 0,
      savedFraction: 0,
      budget,
      breakdown,
      notes: [],
      skillVerdicts: [],
      safetyIssues: [],
      skipped: true,
      reason,
      elapsedMs: Date.now() - startedAt,
    },
  });

  const requested = input.mode === 'AUTO' || input.mode == null ? autoMode(before, budget.contextLength) : input.mode;

  if (requested === 'OFF') return skipReport('OFF', 'optimisation is off for this request');
  if (before < MIN_TOKENS_TO_OPTIMIZE) {
    return skipReport(
      'OFF',
      `the prompt is ${before} tokens, below the ${MIN_TOKENS_TO_OPTIMIZE}-token floor where optimising is worth its risk`,
    );
  }

  const request = input.request ?? lastUserText(input.messages);
  const policy = policyFor(requested);

  // Skills are selected before anything else, because a skill that is not
  // included never becomes a message for the transforms to work on.
  const skillCandidates = input.skills ?? [];
  const selection = policy.selectSkills && skillCandidates.length
    ? select(request, skillCandidates)
    : { included: skillCandidates.map((s) => s.id), excluded: [], verdicts: [], tokensSaved: 0 };

  const selectedTools =
    policy.selectTools && tools.length
      ? filterTools(request, tools)
      : { tools, verdicts: [] as RelevanceVerdict[] };

  // Try the requested mode; on a safety failure, retry gentler until safe or
  // until nothing is being done at all. OFF always passes, so this terminates.
  let mode: OptimizationMode = requested;
  let attempt = applyMode(input.messages, mode);
  let verdict = checkSafety(input.messages, attempt.messages);
  const safetyIssues: SafetyIssue[] = [];

  while (!verdict.safe && mode !== 'OFF') {
    safetyIssues.push(...verdict.issues);
    mode = gentler(mode);
    attempt = applyMode(input.messages, mode);
    verdict = checkSafety(input.messages, attempt.messages);
  }

  const after =
    estimateMessagesTokens(attempt.messages) +
    (selectedTools.tools.length ? breakdownTokens({ messages: [], tools: selectedTools.tools }).tools : 0);
  const tokensSaved = Math.max(0, before - after);

  return {
    messages: attempt.messages,
    tools: selectedTools.tools,
    skills: selection.included,
    report: {
      mode,
      requestedMode: input.mode === 'AUTO' || input.mode == null ? requested : null,
      before,
      after,
      tokensSaved,
      savedFraction: before > 0 ? tokensSaved / before : 0,
      budget: computeBudget({ model: input.model ?? null, usedTokens: after, maxOutputTokens: input.maxOutputTokens }),
      breakdown,
      notes: attempt.notes,
      skillVerdicts: selection.verdicts,
      safetyIssues,
      skipped: false,
      reason: safetyIssues.length
        ? `fell back to ${mode} because a more aggressive pass could not be shown to preserve the request`
        : `ran in ${mode}`,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/** Tool selection, with the same inclusion bias as skills. */
function filterTools(request: string, tools: ToolDefinition[]): { tools: ToolDefinition[]; verdicts: RelevanceVerdict[] } {
  const candidates: RelevanceCandidate[] = tools.map((t) => ({
    id: t.name,
    text: `${t.name} ${t.description} ${JSON.stringify(t.parameters ?? {})}`,
    estimatedTokens: breakdownTokens({ messages: [], tools: [t] }).tools,
  }));
  const result = select(request, candidates);
  const keep = new Set(result.included);
  return { tools: tools.filter((t) => keep.has(t.name)), verdicts: result.verdicts };
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return '';
}
