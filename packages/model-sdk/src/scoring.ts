import type { ModelPerformance, ModelScores, TaskType } from '@meridian/shared';

/**
 * One observed outcome of using a model. The learning loop (spec §61) is fed
 * exclusively from these: request-level telemetry and explicit user feedback,
 * never from the content of a user's private repository.
 */
export interface Observation {
  modelId: string;
  taskType: TaskType;
  success: boolean;
  latencyMs: number;
  ttftMs: number | null;
  outputTokens: number;
  /** Did the tests the agent ran afterwards pass? null when none were run. */
  testsPassed: boolean | null;
  /** Did every tool call the model emitted parse and execute? */
  toolCallsValid: boolean | null;
  /** Explicit thumbs up/down from the user. */
  userFeedback: 'positive' | 'negative' | null;
  at: number;
}

/** Exponentially-weighted mean. Recent behaviour dominates without discarding history. */
function ewma(prev: number | null, next: number, alpha: number): number {
  if (prev == null) return next;
  return prev * (1 - alpha) + next * alpha;
}

/**
 * Confidence weight for a sample count. A model measured three times should
 * not outrank one measured three hundred times on the strength of a lucky run,
 * so scores are shrunk towards the neutral 50 until evidence accumulates.
 */
export function confidence(samples: number): number {
  return samples / (samples + 12);
}

export function shrinkToPrior(score: number | null, samples: number, prior = 50): number | null {
  if (score == null) return null;
  const c = confidence(samples);
  return score * c + prior * (1 - c);
}

const EMPTY_SCORES = (modelId: string): ModelScores => ({
  modelId,
  coding: null,
  reasoning: null,
  general: null,
  toolUse: null,
  vision: null,
  stability: null,
  samples: 0,
  updatedAt: 0,
});

/** Which score dimension a task type teaches us about. */
function dimensionFor(taskType: TaskType): keyof Pick<ModelScores, 'coding' | 'reasoning' | 'general' | 'vision'> {
  switch (taskType) {
    case 'coding':
    case 'debug':
    case 'test':
    case 'review':
      return 'coding';
    case 'reasoning':
    case 'planning':
    case 'research':
      return 'reasoning';
    default:
      return 'general';
  }
}

/**
 * Fold one observation into a model's running scores.
 *
 * The quality signal is deliberately built from things that are objectively
 * checkable — did it succeed, did the tests pass, did its tool calls parse —
 * rather than from a model grading another model's prose.
 */
export function applyObservation(prev: ModelScores | null, obs: Observation, alpha = 0.15): ModelScores {
  const base = prev ?? EMPTY_SCORES(obs.modelId);
  const dim = dimensionFor(obs.taskType);

  let quality = obs.success ? 70 : 15;
  if (obs.testsPassed === true) quality = 95;
  else if (obs.testsPassed === false) quality = 30;
  if (obs.userFeedback === 'positive') quality = Math.min(100, quality + 15);
  else if (obs.userFeedback === 'negative') quality = Math.max(0, quality - 30);

  const next: ModelScores = {
    ...base,
    samples: base.samples + 1,
    stability: ewma(base.stability, obs.success ? 1 : 0, alpha),
    updatedAt: obs.at,
  };
  next[dim] = ewma(base[dim], quality, alpha);
  if (obs.toolCallsValid != null) {
    next.toolUse = ewma(base.toolUse, obs.toolCallsValid ? 100 : 20, alpha);
  }
  return next;
}

const EMPTY_PERF = (modelId: string): ModelPerformance => ({
  modelId,
  ttftMs: null,
  latencyMs: null,
  p95LatencyMs: null,
  jitterMs: null,
  tokensPerSecond: null,
  uptime: null,
  samples: 0,
  updatedAt: 0,
});

/**
 * Fold a latency sample into a model's performance profile.
 *
 * `recentLatencies` is the caller's rolling window; p95 and jitter need the
 * actual distribution, which an EWMA cannot reconstruct.
 */
/**
 * Smallest window in which a nearest-rank 95th percentile is not just the
 * maximum.
 *
 * Nearest-rank picks `sorted[floor(n * 0.95)]`, and for any n ≤ 20 that index
 * is the last one — so a "p95" computed from ten samples is the slowest of the
 * ten, wearing a percentile's name. Reporting that as a tail latency
 * systematically overstates it, and it would be a number Meridian cannot
 * defend when someone asks what it means.
 */
export const MIN_SAMPLES_FOR_P95 = 21;

/**
 * Nearest-rank percentile, or null when the sample is too small for the answer
 * to mean what it says.
 */
export function percentile(values: number[], q: number): number | null {
  if (values.length < MIN_SAMPLES_FOR_P95) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
}

export function applyPerformance(
  prev: ModelPerformance | null,
  sample: { modelId: string; latencyMs: number; ttftMs: number | null; outputTokens: number; success: boolean; at: number },
  recentLatencies: number[],
  alpha = 0.2,
): ModelPerformance {
  const base = prev ?? EMPTY_PERF(sample.modelId);
  const window = [...recentLatencies, sample.latencyMs].slice(-100);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const p95 = percentile(window, 0.95);

  const tps =
    sample.outputTokens > 0 && sample.latencyMs > 0
      ? (sample.outputTokens / sample.latencyMs) * 1000
      : null;

  return {
    ...base,
    latencyMs: ewma(base.latencyMs, sample.latencyMs, alpha),
    ttftMs: sample.ttftMs != null ? ewma(base.ttftMs, sample.ttftMs, alpha) : base.ttftMs,
    p95LatencyMs: p95,
    jitterMs: Math.sqrt(variance),
    tokensPerSecond: tps != null ? ewma(base.tokensPerSecond, tps, alpha) : base.tokensPerSecond,
    uptime: ewma(base.uptime, sample.success ? 1 : 0, alpha),
    samples: base.samples + 1,
    updatedAt: sample.at,
  };
}

/**
 * Recommendation score in [0,100] for a task type: quality, reliability and
 * speed combined. Used for the "best for" label on a model card and as the
 * quality term in routing.
 */
export function recommendationScore(
  scores: ModelScores | null,
  perf: ModelPerformance | null,
  taskType: TaskType,
): number {
  const dim = dimensionFor(taskType);
  const quality = shrinkToPrior(scores?.[dim] ?? null, scores?.samples ?? 0) ?? 50;
  const stability = (scores?.stability ?? 0.9) * 100;
  const toolUse = shrinkToPrior(scores?.toolUse ?? null, scores?.samples ?? 0) ?? 60;
  // Map latency onto [0,100] with 800ms as excellent and 20s as poor.
  const latency = perf?.latencyMs ?? null;
  const speed = latency == null ? 60 : Math.max(0, Math.min(100, 100 - ((latency - 800) / 19_200) * 100));
  const needsTools = taskType === 'coding' || taskType === 'tool-use' || taskType === 'debug';
  const weights = needsTools
    ? { quality: 0.45, stability: 0.2, speed: 0.15, toolUse: 0.2 }
    : { quality: 0.55, stability: 0.25, speed: 0.2, toolUse: 0 };
  return Math.round(
    quality * weights.quality + stability * weights.stability + speed * weights.speed + toolUse * weights.toolUse,
  );
}

/** Human label for a model card's "best for" line. */
export function bestForLabel(scores: ModelScores | null): string {
  if (!scores || scores.samples < 3) return 'Not yet measured';
  const entries: [string, number | null][] = [
    ['Coding', scores.coding],
    ['Reasoning', scores.reasoning],
    ['General', scores.general],
  ];
  const ranked = entries.filter((e): e is [string, number] => e[1] != null).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return 'Not yet measured';
  const top = ranked[0];
  const second = ranked[1];
  return second && top[1] - second[1] < 6 ? `${top[0]} / ${second[0]}` : top[0];
}

/** Convert a 0-100 score into the five-star display used on model cards. */
export function stars(score: number | null): number {
  if (score == null) return 0;
  return Math.max(0, Math.min(5, Math.round((score / 100) * 5)));
}
