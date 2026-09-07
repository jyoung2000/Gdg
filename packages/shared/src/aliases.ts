/**
 * Dynamic model aliases.
 *
 * A client that hard-codes `groq/llama-3.3-70b-versatile` breaks the day that
 * model is retired, and it cannot benefit from a better free model appearing
 * next week. An alias names an *intent* instead — "the best free coding model
 * you can reach right now" — and is resolved against the live route graph on
 * every request, so the answer improves without the client changing.
 *
 * Aliases are deliberately thin. Each one is a set of constraints on the
 * request Meridian already understands: a routing mode, a free-only or
 * local-only gate, a task type, a required capability. There is no second
 * routing engine behind them and no static mapping to a chosen model — an
 * alias that resolved to a fixed model would be a hard-coded name with extra
 * steps, which is the problem it exists to solve.
 *
 * The safety property: an alias may narrow what is acceptable but may never
 * widen what is permitted. `meridian/cheapest` expresses a preference for low
 * cost, and it still cannot spend money the operator's policy forbids —
 * `allowPaid` is not something an alias can set.
 */
import type { Modality, RoutingMode, TaskType } from './types.js';

export interface AliasDefinition {
  /** The name a client uses, e.g. `meridian/free`. */
  id: string;
  /** One line, shown in the model list. */
  description: string;
  /** Routing mode to apply, when the alias implies one. */
  mode?: RoutingMode;
  /** Restrict to routes that cannot draw down money. */
  freeOnly?: boolean;
  /** Restrict to models on the operator's own hardware. */
  localOnly?: boolean;
  /** Bias capability weighting toward a kind of work. */
  taskType?: TaskType;
  /** Hard capability requirement — a model without it cannot serve. */
  requiredCapabilities?: string[];
  /** Non-text aliases route to a different modality entirely. */
  modality?: Modality;
}

/**
 * The catalogue of aliases.
 *
 * Kept small on purpose. Every entry has to be explainable in one line, and a
 * long list of near-identical aliases is worse for a client than a short list
 * plus the `meridian` request extensions.
 */
export const MODEL_ALIASES: AliasDefinition[] = [
  {
    id: 'meridian/auto',
    description: 'Let Meridian choose, balancing quality, cost, speed and availability.',
    mode: 'AUTO',
  },
  {
    id: 'meridian/free',
    description: 'The best route that cannot charge anything. Never trial credit.',
    mode: 'FREE_FIRST',
    freeOnly: true,
  },
  {
    id: 'meridian/cheapest',
    description: 'The lowest expected cost among routes that can serve the request.',
    mode: 'CHEAP_FIRST',
  },
  {
    id: 'meridian/best-value',
    description: 'The best balance of quality, reliability and cost.',
    mode: 'BALANCED',
  },
  {
    id: 'meridian/frontier',
    description: 'The highest measured quality, cost notwithstanding.',
    mode: 'QUALITY_FIRST',
  },
  {
    id: 'meridian/fastest',
    description: 'The lowest measured latency among healthy routes.',
    mode: 'FASTEST',
  },
  {
    id: 'meridian/local',
    description: 'Only models running on this machine. Nothing leaves it.',
    mode: 'LOCAL_FIRST',
    localOnly: true,
  },
  {
    id: 'meridian/free-coder',
    description: 'The best free model for writing and changing code.',
    mode: 'FREE_FIRST',
    freeOnly: true,
    taskType: 'coding',
  },
  {
    id: 'meridian/free-reasoning',
    description: 'The best free model for multi-step reasoning.',
    mode: 'FREE_FIRST',
    freeOnly: true,
    taskType: 'reasoning',
  },
  {
    id: 'meridian/free-vision',
    description: 'The best free model that can actually see an image.',
    mode: 'FREE_FIRST',
    freeOnly: true,
    requiredCapabilities: ['vision'],
  },
  {
    id: 'meridian/free-image',
    description: 'The best free route for generating an image.',
    mode: 'FREE_FIRST',
    freeOnly: true,
    modality: 'image',
  },
];

const BY_ID = new Map(MODEL_ALIASES.map((a) => [a.id, a]));

/**
 * Bare names accepted for the default alias.
 *
 * `auto` predates the namespaced aliases and is what several clients already
 * send, so it keeps working rather than becoming a model-not-found.
 */
const BARE_AUTO = new Set(['auto', 'meridian', 'meridian/auto', 'default']);

/** Is this model name an alias rather than a real model id? */
export function isAlias(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return BARE_AUTO.has(n) || BY_ID.has(n);
}

/**
 * Resolve a name to its alias definition, or null when it is a real model id.
 *
 * Unknown names starting with `meridian/` deliberately return null rather than
 * silently falling back to AUTO: a client asking for `meridian/free-video` when
 * no such alias exists should be told, not quietly given a paid text model.
 */
export function resolveAlias(name: string | null | undefined): AliasDefinition | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (BARE_AUTO.has(n)) return BY_ID.get('meridian/auto') ?? null;
  return BY_ID.get(n) ?? null;
}

/** Alias names that look like ours but are not defined — worth an error. */
export function isUnknownMeridianAlias(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n.startsWith('meridian/') && !BY_ID.has(n);
}
