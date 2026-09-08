/**
 * How much room there actually is.
 *
 * A context window is not a token budget. The window has to hold the prompt
 * *and* the answer, and a request that fills it exactly leaves the model
 * nowhere to reply from — which fails at generation time with an error that
 * points at the output limit rather than at the prompt that caused it.
 *
 * So the budget here is the window minus what the reply needs, and callers get
 * told when they are over it rather than finding out from the provider.
 */
import type { ModelDescriptor } from '@meridian/shared';

export interface ContextBudget {
  /** The model's full window, or null when the provider publishes none. */
  contextLength: number | null;
  /** Tokens held back for the response. */
  reservedForOutput: number;
  /** What the prompt may actually use: window − reserve. Null when unknown. */
  available: number | null;
  /** Estimated prompt tokens as things stand. */
  used: number;
  /** available − used, floored at zero. Null when the window is unknown. */
  remaining: number | null;
  /** used / available. Null when the window is unknown. */
  pressure: number | null;
  /** True when the prompt does not fit and something has to give. */
  over: boolean;
}

/**
 * Output reserve when the caller names no `maxTokens`.
 *
 * Generous on purpose: running out of room for the answer is a hard failure,
 * while reserving a little too much only trims a prompt slightly earlier than
 * strictly necessary.
 */
export const DEFAULT_OUTPUT_RESERVE = 4096;

/**
 * Never hand the prompt more than this share of a window.
 *
 * Token estimates are estimates. A prompt measured at exactly the window size
 * is, in practice, sometimes over it — and the failure is total. Keeping a
 * margin means an underestimate costs a slightly smaller prompt instead of a
 * rejected request.
 */
export const SAFETY_MARGIN = 0.95;

export function computeBudget(input: {
  model: Pick<ModelDescriptor, 'contextLength' | 'maxOutputTokens'> | null;
  usedTokens: number;
  maxOutputTokens?: number | null;
}): ContextBudget {
  const contextLength = input.model?.contextLength ?? null;
  const reservedForOutput = Math.max(
    1,
    input.maxOutputTokens ?? input.model?.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE,
  );

  if (!contextLength || contextLength <= 0) {
    return {
      contextLength: null,
      reservedForOutput,
      available: null,
      used: input.usedTokens,
      remaining: null,
      pressure: null,
      // Unknown is not "over". A model that publishes no window may well have a
      // large one, and refusing the request would turn missing metadata into a
      // failure the user cannot fix.
      over: false,
    };
  }

  const available = Math.max(0, Math.floor(contextLength * SAFETY_MARGIN) - reservedForOutput);
  return {
    contextLength,
    reservedForOutput,
    available,
    used: input.usedTokens,
    remaining: Math.max(0, available - input.usedTokens),
    pressure: available > 0 ? input.usedTokens / available : null,
    over: input.usedTokens > available,
  };
}

/** Human phrasing for the token panel and the CLI. */
export function describeBudget(budget: ContextBudget): string {
  if (budget.available == null) return `${budget.used.toLocaleString()} tokens (window not published)`;
  const pct = budget.pressure != null ? Math.round(budget.pressure * 100) : 0;
  return `${budget.used.toLocaleString()} / ${budget.available.toLocaleString()} tokens (${pct}%)`;
}
