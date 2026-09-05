import type { PrivacyMode, RoutingMode, TrustLevel } from '@meridian/shared';

/**
 * How much each factor matters, per routing mode. Weights sum to 1 within a
 * mode so scores stay comparable across modes.
 */
export interface ModeWeights {
  /** Measured quality for the task type. */
  quality: number;
  /** Inverse latency. */
  speed: number;
  /** Inverse cost. */
  cost: number;
  /** Bonus for a model that cannot charge money. */
  free: number;
  /** Bonus for a model running on the operator's own hardware. */
  local: number;
  /** Bonus for a model or provider the user has expressed a preference for. */
  preference: number;
  /** Provider reliability. */
  reliability: number;
}

const W = (w: Partial<ModeWeights>): ModeWeights => ({
  quality: 0,
  speed: 0,
  cost: 0,
  free: 0,
  local: 0,
  preference: 0,
  reliability: 0,
  ...w,
});

/**
 * AUTO is the default and is deliberately free-leaning: the product's promise
 * is that it never spends money without being told to, so the balanced mode
 * still puts real weight on the free bonus.
 */
export const MODE_WEIGHTS: Record<RoutingMode, ModeWeights> = {
  AUTO: W({ quality: 0.34, speed: 0.14, cost: 0.1, free: 0.16, local: 0.03, preference: 0.08, reliability: 0.15 }),
  BEST: W({ quality: 0.6, speed: 0.05, cost: 0.0, free: 0.0, local: 0.0, preference: 0.15, reliability: 0.2 }),
  FAST: W({ quality: 0.2, speed: 0.5, cost: 0.03, free: 0.05, local: 0.05, preference: 0.05, reliability: 0.12 }),
  CHEAP: W({ quality: 0.22, speed: 0.08, cost: 0.42, free: 0.15, local: 0.03, preference: 0.03, reliability: 0.07 }),
  FREE: W({ quality: 0.3, speed: 0.12, cost: 0.0, free: 0.4, local: 0.05, preference: 0.03, reliability: 0.1 }),
  LOCAL: W({ quality: 0.3, speed: 0.15, cost: 0.0, free: 0.05, local: 0.4, preference: 0.03, reliability: 0.07 }),

  FREE_FIRST: W({ quality: 0.28, speed: 0.1, cost: 0.05, free: 0.42, local: 0.04, preference: 0.03, reliability: 0.08 }),
  CHEAP_FIRST: W({ quality: 0.22, speed: 0.08, cost: 0.45, free: 0.14, local: 0.03, preference: 0.03, reliability: 0.05 }),
  QUALITY_FIRST: W({ quality: 0.62, speed: 0.04, cost: 0.0, free: 0.0, local: 0.0, preference: 0.14, reliability: 0.2 }),
  FASTEST: W({ quality: 0.15, speed: 0.58, cost: 0.02, free: 0.03, local: 0.05, preference: 0.03, reliability: 0.14 }),
  LOCAL_FIRST: W({ quality: 0.26, speed: 0.12, cost: 0.0, free: 0.04, local: 0.48, preference: 0.03, reliability: 0.07 }),
  USER_FIRST: W({ quality: 0.24, speed: 0.08, cost: 0.05, free: 0.1, local: 0.03, preference: 0.42, reliability: 0.08 }),
  ADMIN_FIRST: W({ quality: 0.3, speed: 0.1, cost: 0.1, free: 0.1, local: 0.03, preference: 0.25, reliability: 0.12 }),
  BALANCED: W({ quality: 0.3, speed: 0.2, cost: 0.2, free: 0.1, local: 0.03, preference: 0.05, reliability: 0.12 }),
  CUSTOM: W({ quality: 0.34, speed: 0.14, cost: 0.1, free: 0.16, local: 0.03, preference: 0.08, reliability: 0.15 }),
};

/** Human sentence describing what a mode optimises for. */
export const MODE_DESCRIPTION: Record<RoutingMode, string> = {
  AUTO: 'Balances quality, speed and cost, and prefers free capacity',
  BEST: 'Highest measured quality regardless of speed',
  FAST: 'Lowest latency that still meets the task requirements',
  CHEAP: 'Lowest cost per call',
  FREE: 'Only models that cannot charge money',
  LOCAL: 'Only models running on your own hardware',
  FREE_FIRST: 'Exhausts free capacity before considering anything paid',
  CHEAP_FIRST: 'Cheapest capable model first',
  QUALITY_FIRST: 'Best measured quality first',
  FASTEST: 'Lowest measured latency first',
  LOCAL_FIRST: 'Your own hardware first, remote providers only as fallback',
  USER_FIRST: 'Your saved model and provider preferences first',
  ADMIN_FIRST: 'Operator-configured providers and pools first',
  BALANCED: 'Even weighting across quality, speed and cost',
  CUSTOM: 'Your own weighting',
};

/** Modes that must never select a model capable of charging money. */
export const STRICTLY_FREE_MODES: readonly RoutingMode[] = ['FREE', 'LOCAL', 'LOCAL_FIRST'];

/** Modes that must never leave the operator's own hardware. */
export const STRICTLY_LOCAL_MODES: readonly RoutingMode[] = ['LOCAL'];

/** Trust levels a privacy mode permits. */
export const PRIVACY_TRUST: Record<PrivacyMode, readonly TrustLevel[]> = {
  STRICT_LOCAL: [],
  TRUSTED_ONLY: ['verified', 'trusted'],
  FREE_PROVIDERS: ['verified', 'trusted', 'unknown'],
  ANY_PROVIDER: ['verified', 'trusted', 'unknown', 'untrusted'],
};

export const PRIVACY_DESCRIPTION: Record<PrivacyMode, string> = {
  STRICT_LOCAL: 'Nothing leaves this machine. Only local models are eligible.',
  TRUSTED_ONLY: 'Only providers you have verified or explicitly marked as trusted.',
  FREE_PROVIDERS:
    'Includes free providers whose data-use policies vary. Review each provider’s policy before sending anything sensitive.',
  ANY_PROVIDER: 'Every configured provider, including ones whose data handling is unknown.',
};

/** Normalise the plain-language UI modes onto their explicit policy equivalents. */
export function canonicalMode(mode: RoutingMode): RoutingMode {
  switch (mode) {
    case 'FREE':
      return 'FREE';
    case 'CHEAP':
      return 'CHEAP_FIRST';
    case 'BEST':
      return 'QUALITY_FIRST';
    case 'FAST':
      return 'FASTEST';
    default:
      return mode;
  }
}
