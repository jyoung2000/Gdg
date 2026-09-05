import { traitsFor, type ErrorCode, type HealthState, type ProviderHealth } from '@meridian/shared';

export interface CircuitOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** Consecutive successes in half-open before the circuit closes again. */
  successThreshold: number;
  /** Floor for the cooldown applied when the circuit opens, ms. */
  minCooldownMs: number;
  /** Ceiling for the cooldown, ms. */
  maxCooldownMs: number;
  now: () => number;
}

const DEFAULTS: CircuitOptions = {
  failureThreshold: 3,
  successThreshold: 2,
  minCooldownMs: 5_000,
  maxCooldownMs: 15 * 60_000,
  now: () => Date.now(),
};

function blank(providerId: string): ProviderHealth {
  return {
    providerId,
    state: 'unknown',
    circuit: 'closed',
    consecutiveFailures: 0,
    successCount: 0,
    failureCount: 0,
    latencyMs: null,
    errorRate: 0,
    cooldownUntil: null,
    lastCheckedAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

/**
 * Provider health with a circuit breaker.
 *
 * The breaker is what stops the fallback engine from hammering a provider that
 * is already failing: once open, the provider is skipped during candidate
 * selection entirely, so a rate-limited provider costs one request rather than
 * one per call for the length of its cooldown.
 */
export class HealthStore {
  private readonly opts: CircuitOptions;
  private readonly health = new Map<string, ProviderHealth>();
  /** Rolling outcome window per provider, newest last. */
  private readonly window = new Map<string, boolean[]>();
  /** Consecutive successes observed while half-open. */
  private readonly probeSuccesses = new Map<string, number>();
  private readonly listeners = new Set<(h: ProviderHealth) => void>();

  constructor(opts: Partial<CircuitOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  onChange(fn: (h: ProviderHealth) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(h: ProviderHealth): void {
    for (const fn of this.listeners) fn(h);
  }

  get(providerId: string): ProviderHealth {
    let h = this.health.get(providerId);
    if (!h) {
      h = blank(providerId);
      this.health.set(providerId, h);
    }
    // Lazily transition an expired cooldown into the half-open probe state.
    if (h.circuit === 'open' && h.cooldownUntil != null && this.opts.now() >= h.cooldownUntil) {
      h = { ...h, circuit: 'half_open', cooldownUntil: null };
      this.health.set(providerId, h);
      this.probeSuccesses.set(providerId, 0);
      this.emit(h);
    }
    return h;
  }

  all(): ProviderHealth[] {
    return [...this.health.keys()].map((id) => this.get(id));
  }

  /** Hydrate from persisted rows on startup. */
  load(rows: ProviderHealth[]): void {
    for (const r of rows) this.health.set(r.providerId, r);
  }

  /** True when the provider may currently receive traffic. */
  isAvailable(providerId: string): boolean {
    const h = this.get(providerId);
    return h.circuit !== 'open';
  }

  /** Seconds until an open circuit is retried; null when it is not open. */
  cooldownRemaining(providerId: string): number | null {
    const h = this.get(providerId);
    if (h.circuit !== 'open' || h.cooldownUntil == null) return null;
    return Math.max(0, Math.ceil((h.cooldownUntil - this.opts.now()) / 1000));
  }

  recordSuccess(providerId: string, latencyMs: number): ProviderHealth {
    const prev = this.get(providerId);
    const win = this.pushWindow(providerId, true);
    let circuit = prev.circuit;

    if (prev.circuit === 'half_open') {
      const probes = (this.probeSuccesses.get(providerId) ?? 0) + 1;
      this.probeSuccesses.set(providerId, probes);
      if (probes >= this.opts.successThreshold) {
        circuit = 'closed';
        this.probeSuccesses.delete(providerId);
      }
    } else {
      circuit = 'closed';
    }

    const next: ProviderHealth = {
      ...prev,
      state: 'healthy',
      circuit,
      consecutiveFailures: 0,
      successCount: prev.successCount + 1,
      latencyMs: prev.latencyMs == null ? latencyMs : prev.latencyMs * 0.8 + latencyMs * 0.2,
      errorRate: errorRate(win),
      cooldownUntil: circuit === 'closed' ? null : prev.cooldownUntil,
      lastCheckedAt: this.opts.now(),
    };
    this.health.set(providerId, next);
    this.emit(next);
    return next;
  }

  recordFailure(providerId: string, code: ErrorCode, message: string, retryAfterSec?: number | null): ProviderHealth {
    const prev = this.get(providerId);
    const win = this.pushWindow(providerId, false);
    const consecutive = prev.consecutiveFailures + 1;
    const trait = traitsFor(code);

    // A failure while probing re-opens immediately; otherwise wait for the
    // threshold so one blip does not take a healthy provider out of rotation.
    const shouldOpen =
      prev.circuit === 'half_open' || consecutive >= this.opts.failureThreshold || !trait.retryable;

    let cooldownMs = 0;
    if (shouldOpen) {
      const base = Math.max(trait.cooldownSec * 1000, this.opts.minCooldownMs);
      // Back off further each time the breaker re-opens without a clean run.
      const escalated = base * 2 ** Math.min(4, Math.max(0, consecutive - this.opts.failureThreshold));
      cooldownMs = Math.min(this.opts.maxCooldownMs, Math.max(escalated, (retryAfterSec ?? 0) * 1000));
    }

    const next: ProviderHealth = {
      ...prev,
      state: stateFor(code),
      circuit: shouldOpen ? 'open' : prev.circuit === 'half_open' ? 'half_open' : 'closed',
      consecutiveFailures: consecutive,
      failureCount: prev.failureCount + 1,
      errorRate: errorRate(win),
      cooldownUntil: shouldOpen ? this.opts.now() + cooldownMs : prev.cooldownUntil,
      lastCheckedAt: this.opts.now(),
      lastErrorAt: this.opts.now(),
      lastError: message.slice(0, 300),
    };
    this.health.set(providerId, next);
    if (shouldOpen) this.probeSuccesses.delete(providerId);
    this.emit(next);
    return next;
  }

  /** Result of an out-of-band health probe; does not affect the breaker. */
  recordProbe(providerId: string, ok: boolean, latencyMs: number, detail?: string): ProviderHealth {
    const prev = this.get(providerId);
    const next: ProviderHealth = {
      ...prev,
      state: ok ? (prev.circuit === 'open' ? prev.state : 'healthy') : 'offline',
      latencyMs: ok ? (prev.latencyMs == null ? latencyMs : prev.latencyMs * 0.8 + latencyMs * 0.2) : prev.latencyMs,
      lastCheckedAt: this.opts.now(),
      lastError: ok ? prev.lastError : (detail ?? prev.lastError),
    };
    this.health.set(providerId, next);
    this.emit(next);
    return next;
  }

  /** Force a provider back into rotation — an operator action. */
  reset(providerId: string): ProviderHealth {
    const next = blank(providerId);
    this.health.set(providerId, next);
    this.window.delete(providerId);
    this.probeSuccesses.delete(providerId);
    this.emit(next);
    return next;
  }

  private pushWindow(providerId: string, ok: boolean): boolean[] {
    const win = [...(this.window.get(providerId) ?? []), ok].slice(-50);
    this.window.set(providerId, win);
    return win;
  }
}

function errorRate(win: boolean[]): number {
  if (!win.length) return 0;
  return Math.round((win.filter((v) => !v).length / win.length) * 1000) / 1000;
}

function stateFor(code: ErrorCode): HealthState {
  switch (code) {
    case 'rate_limited':
    case 'quota_exhausted':
      return 'rate_limited';
    case 'authentication_failed':
      return 'unauthorized';
    case 'provider_unavailable':
    case 'timeout':
      return 'offline';
    default:
      return 'degraded';
  }
}
