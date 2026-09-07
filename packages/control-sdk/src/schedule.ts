/**
 * Per-provider discovery pacing.
 *
 * Discovery talks to other people's APIs, so the interesting cases are the
 * unhappy ones: a provider that rate-limits us, one that is down, and a user
 * who opens the models screen twenty times in a minute. Each is handled by the
 * same small state machine — a minimum interval, exponential backoff on
 * failure with jitter, and a cap on consecutive attempts — rather than by
 * hoping the caller is polite.
 */

export interface ProviderSchedule {
  providerId: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  /** Earliest time a new attempt is permitted. */
  nextEligibleAt: number;
  lastError: string | null;
}

export interface SchedulerOptions {
  /** Never re-query the same provider more often than this. */
  minIntervalMs?: number;
  /** First backoff step after a failure. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Stop retrying after this many consecutive failures until a manual run. */
  maxConsecutiveFailures?: number;
  now?: () => number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

export class DiscoveryScheduler {
  private readonly minIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly state = new Map<string, ProviderSchedule>();

  constructor(opts: SchedulerOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 5 * 60_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60 * 60_000;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 6;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  scheduleOf(providerId: string): ProviderSchedule {
    const existing = this.state.get(providerId);
    if (existing) return existing;
    const fresh: ProviderSchedule = {
      providerId,
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      nextEligibleAt: 0,
      lastError: null,
    };
    this.state.set(providerId, fresh);
    return fresh;
  }

  all(): ProviderSchedule[] {
    return [...this.state.values()];
  }

  /**
   * May this provider be queried now?
   *
   * `force` is the manual-refresh path: it ignores the minimum interval and
   * the backoff, because a user pressing a button is a stronger signal than a
   * timer — but it still records the attempt, so a manual refresh cannot be
   * used to hammer a provider by holding down the button.
   */
  canRun(providerId: string, opts: { force?: boolean } = {}): { allowed: boolean; reason: string | null; waitMs: number } {
    const s = this.scheduleOf(providerId);
    const now = this.now();
    if (opts.force) {
      // Even forced runs respect a short floor so a click storm cannot become
      // a request storm.
      const floor = 5_000;
      if (s.lastAttemptAt != null && now - s.lastAttemptAt < floor) {
        return { allowed: false, reason: 'a discovery run for this provider just started', waitMs: floor - (now - s.lastAttemptAt) };
      }
      return { allowed: true, reason: null, waitMs: 0 };
    }
    if (s.consecutiveFailures >= this.maxConsecutiveFailures) {
      return {
        allowed: false,
        reason: `paused after ${s.consecutiveFailures} consecutive failures — refresh manually once the cause is fixed`,
        waitMs: 0,
      };
    }
    if (now < s.nextEligibleAt) {
      return { allowed: false, reason: 'backing off after a recent failure', waitMs: s.nextEligibleAt - now };
    }
    if (s.lastAttemptAt != null && now - s.lastAttemptAt < this.minIntervalMs) {
      return { allowed: false, reason: 'queried recently', waitMs: this.minIntervalMs - (now - s.lastAttemptAt) };
    }
    return { allowed: true, reason: null, waitMs: 0 };
  }

  markAttempt(providerId: string): void {
    const s = this.scheduleOf(providerId);
    s.lastAttemptAt = this.now();
  }

  markSuccess(providerId: string): void {
    const s = this.scheduleOf(providerId);
    const now = this.now();
    s.lastAttemptAt = now;
    s.lastSuccessAt = now;
    s.consecutiveFailures = 0;
    s.nextEligibleAt = now + this.minIntervalMs;
    s.lastError = null;
  }

  markFailure(providerId: string, error: string): void {
    const s = this.scheduleOf(providerId);
    const now = this.now();
    s.lastAttemptAt = now;
    s.consecutiveFailures += 1;
    s.lastError = error.slice(0, 300);
    const step = Math.min(this.baseBackoffMs * 2 ** (s.consecutiveFailures - 1), this.maxBackoffMs);
    // Jitter keeps several providers that failed together from retrying in
    // lockstep and re-creating the same burst.
    s.nextEligibleAt = now + step * (0.75 + this.random() * 0.5);
  }

  /** Clear the failure pause for a provider, e.g. after a credential change. */
  reset(providerId: string): void {
    this.state.delete(providerId);
  }
}
