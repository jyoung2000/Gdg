import { DEFAULT_PORT as PORT, type RoutingMode } from '@meridian/shared';

export const DEFAULT_PORT = PORT;

/**
 * The six modes surfaced as the primary control. The rest are the explicit
 * policies, shown behind "Advanced" — presenting fifteen equal choices would
 * make the common case harder, not more powerful.
 */
export const MODE_DESCRIPTION_KEYS: RoutingMode[] = ['AUTO', 'BEST', 'FAST', 'CHEAP', 'FREE', 'LOCAL'];

/** Parse a positive integer query parameter, with a bound and a default. */
export function intParam(raw: unknown, dflt: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}
