/**
 * How hard to work at making a prompt smaller.
 *
 * The goal is **not** the smallest possible prompt. A 50% reduction that breaks
 * the answer is a failure; a 20% reduction with the answer unchanged is a win.
 * So each mode is defined by what it is *allowed to remove*, and every mode
 * shares one rule it may not break: whatever the user actually said stays.
 */
export const OPTIMIZATION_MODES = ['OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] as const;
export type OptimizationMode = (typeof OPTIMIZATION_MODES)[number];

export interface ModePolicy {
  /** Drop a block whose exact content is already present elsewhere. */
  deduplicate: boolean;
  /** Replace the body of superseded tool results with a short marker. */
  elideStaleToolResults: boolean;
  /** Drop turns from the middle of a long conversation. */
  windowHistory: boolean;
  /** Include only skills that look relevant to this request. */
  selectSkills: boolean;
  /** Include only tools that look relevant to this request. */
  selectTools: boolean;
  /**
   * Turns at the end of a conversation that are always kept whole.
   *
   * The most recent exchanges are where the actual task lives; a window that
   * eats into them saves tokens by removing the thing the model needs most.
   */
  keepRecentTurns: number;
  /**
   * Tool results at the end that keep their full body.
   *
   * A model that has just read a file needs its contents. A model that read it
   * nine calls ago and has moved on usually needs to know only that it did.
   */
  keepRecentToolResults: number;
}

const POLICIES: Record<OptimizationMode, ModePolicy> = {
  OFF: {
    deduplicate: false,
    elideStaleToolResults: false,
    windowHistory: false,
    selectSkills: false,
    selectTools: false,
    keepRecentTurns: Number.POSITIVE_INFINITY,
    keepRecentToolResults: Number.POSITIVE_INFINITY,
  },
  // Removes only what is provably redundant: byte-identical content that is
  // already in the prompt somewhere else. Nothing is summarised, nothing is
  // judged relevant or irrelevant, and no unique content is lost — so this is
  // safe to apply to anything, including a request you do not understand.
  CONSERVATIVE: {
    deduplicate: true,
    elideStaleToolResults: false,
    windowHistory: false,
    selectSkills: false,
    selectTools: false,
    keepRecentTurns: Number.POSITIVE_INFINITY,
    keepRecentToolResults: Number.POSITIVE_INFINITY,
  },
  // The default. Adds judgement: old tool output is elided, a long history is
  // windowed, and skills are chosen for the request rather than all attached.
  // Tools are deliberately *not* filtered here — a missing tool changes what
  // the model is able to do, not merely what it knows.
  BALANCED: {
    deduplicate: true,
    elideStaleToolResults: true,
    windowHistory: true,
    selectSkills: true,
    selectTools: false,
    keepRecentTurns: 8,
    keepRecentToolResults: 4,
  },
  // For prompts that will not otherwise fit. Narrows the windows and filters
  // tools too, which is the one change here that can alter behaviour rather
  // than just cost — hence its own mode rather than a wider default.
  AGGRESSIVE: {
    deduplicate: true,
    elideStaleToolResults: true,
    windowHistory: true,
    selectSkills: true,
    selectTools: true,
    keepRecentTurns: 4,
    keepRecentToolResults: 2,
  },
};

export function policyFor(mode: OptimizationMode): ModePolicy {
  return POLICIES[mode] ?? POLICIES.BALANCED;
}

/**
 * Fractions of a model's context window at which each mode takes over.
 *
 * Expressed as a share of the window rather than an absolute token count
 * because "large" means something different for an 8k model and a 200k one.
 */
export const PRESSURE_THRESHOLDS = {
  /** Below this, optimising costs more attention than it saves tokens. */
  conservative: 0.25,
  balanced: 0.5,
  aggressive: 0.8,
} as const;

/**
 * Pick a mode from how full the window already is.
 *
 * A small prompt is left alone on purpose. Trimming a 2k-token request inside a
 * 128k window saves nothing anybody will notice and risks removing something
 * that mattered — the classic way an optimiser makes a system worse while
 * reporting a positive number.
 */
export function autoMode(estimatedTokens: number, contextLength: number | null): OptimizationMode {
  // With no published window there is no pressure to measure. Deduplication is
  // still safe and still worth doing, so this lands on CONSERVATIVE rather than
  // guessing at a limit.
  if (!contextLength || contextLength <= 0) return 'CONSERVATIVE';
  const pressure = estimatedTokens / contextLength;
  if (pressure >= PRESSURE_THRESHOLDS.aggressive) return 'AGGRESSIVE';
  if (pressure >= PRESSURE_THRESHOLDS.balanced) return 'BALANCED';
  if (pressure >= PRESSURE_THRESHOLDS.conservative) return 'CONSERVATIVE';
  return 'OFF';
}
