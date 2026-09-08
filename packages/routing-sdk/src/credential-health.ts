import {
  blankCredentialHealth,
  isAccountFault,
  quotaIsExhausted,
  traitsFor,
  type CredentialHealth,
  type CredentialQuota,
  type CredentialState,
  type ErrorCode,
  type QuotaDimension,
  type RateLimitSnapshot,
} from '@meridian/shared';

export interface CredentialHealthOptions {
  /** Consecutive failures before an account is put on cooldown. */
  failureThreshold: number;
  /** Floor for a cooldown, ms. */
  minCooldownMs: number;
  /** Ceiling for a cooldown, ms. */
  maxCooldownMs: number;
  now: () => number;
}

const DEFAULTS: CredentialHealthOptions = {
  failureThreshold: 3,
  minCooldownMs: 5_000,
  maxCooldownMs: 15 * 60_000,
  now: () => Date.now(),
};

function stateFor(code: ErrorCode): CredentialState {
  switch (code) {
    case 'authentication_failed':
      return 'unauthorized';
    case 'rate_limited':
      return 'rate_limited';
    case 'quota_exhausted':
      return 'quota_exhausted';
    default:
      return 'failing';
  }
}

/**
 * Health and quota, per account.
 *
 * This is the provider circuit breaker's sibling, and the reason it exists is
 * that the two were one thing. Every failure went to the provider's breaker, so
 * a 401 on one user's key marked the whole provider unauthorized for everybody
 * — the classic multi-tenant fault, where one tenant's broken state becomes
 * everyone's outage.
 *
 * The split is by cause rather than by convenience:
 *
 * - A 401, a 429 or a spent quota is a fact about the ACCOUNT. It lands here.
 *   The provider is not marked, because the provider is fine.
 * - A timeout, a 5xx or an unreachable host is a fact about the SERVICE. It
 *   lands on the provider's breaker, and only touches the account's last-seen
 *   fields — recording it as an account failure would cool down every key on a
 *   provider having a bad minute, and then route around capacity that works.
 *
 * A cooldown here is deliberately softer than the provider breaker. An account
 * that answered `Retry-After: 30` is busy, not broken, and the correct response
 * is to use a different key for thirty seconds — not to stop using this one.
 */
export class CredentialHealthStore {
  private readonly opts: CredentialHealthOptions;
  private readonly health = new Map<string, CredentialHealth>();
  /** Quota per credential, keyed `${credentialId}|${dimension}`. */
  private readonly quotas = new Map<string, CredentialQuota>();
  private readonly listeners = new Set<(h: CredentialHealth) => void>();
  private readonly quotaListeners = new Set<(q: CredentialQuota) => void>();

  constructor(opts: Partial<CredentialHealthOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  onChange(fn: (h: CredentialHealth) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onQuota(fn: (q: CredentialQuota) => void): () => void {
    this.quotaListeners.add(fn);
    return () => this.quotaListeners.delete(fn);
  }

  /** Rehydrate from storage. Emits nothing: this is not news, it is history. */
  load(rows: CredentialHealth[], quotas: CredentialQuota[] = []): void {
    for (const h of rows) this.health.set(h.credentialId, h);
    for (const q of quotas) this.quotas.set(`${q.credentialId}|${q.dimension}`, q);
  }

  get(credentialId: string, providerId = ''): CredentialHealth {
    const existing = this.health.get(credentialId);
    if (existing) return existing;
    const blank = blankCredentialHealth(credentialId, providerId, this.opts.now());
    this.health.set(credentialId, blank);
    return blank;
  }

  all(): CredentialHealth[] {
    return [...this.health.values()];
  }

  quotasFor(credentialId: string): CredentialQuota[] {
    return [...this.quotas.values()].filter((q) => q.credentialId === credentialId);
  }

  /**
   * Should this account be used right now?
   *
   * Two ways to answer no, and the asymmetry is deliberate. A cooldown is a
   * bounded refusal — the account comes back by itself. A published quota of
   * zero is a refusal until the window resets, and once it has, the reading is
   * stale rather than authoritative, so it stops applying.
   *
   * Anything unknown is available. An account nobody has published a limit for
   * is not an account that is out of room.
   */
  available(credentialId: string): boolean {
    const now = this.opts.now();
    const h = this.health.get(credentialId);
    if (h?.cooldownUntil != null && now < h.cooldownUntil) return false;
    for (const q of this.quotasFor(credentialId)) {
      if (!quotaIsExhausted(q)) continue;
      // A reset in the past means the zero we saw belongs to a window that has
      // since rolled over. Believing it forever would retire a working key.
      if (q.resetsAt != null && now >= q.resetsAt) continue;
      return false;
    }
    return true;
  }

  /** Why an account is unavailable, in words a person can act on. */
  unavailableReason(credentialId: string): string | null {
    if (this.available(credentialId)) return null;
    const now = this.opts.now();
    const h = this.health.get(credentialId);
    if (h?.cooldownUntil != null && now < h.cooldownUntil) {
      const sec = Math.ceil((h.cooldownUntil - now) / 1000);
      return `${h.state.replace('_', ' ')}, retrying in ${sec}s`;
    }
    const spent = this.quotasFor(credentialId).find((q) => quotaIsExhausted(q));
    return spent ? `no ${spent.dimension} quota left on this account` : 'unavailable';
  }

  recordSuccess(credentialId: string, providerId: string): CredentialHealth {
    const prev = this.get(credentialId, providerId);
    const next: CredentialHealth = {
      ...prev,
      providerId: providerId || prev.providerId,
      state: 'healthy',
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSuccessAt: this.opts.now(),
      updatedAt: this.opts.now(),
    };
    this.health.set(credentialId, next);
    this.emit(next);
    return next;
  }

  /**
   * Record a failure against the account.
   *
   * Callers pass every failure; this decides what it means. A fault that is not
   * the account's updates the last-seen fields and nothing else — no state
   * change, no cooldown — because a provider outage is not evidence about a key
   * and must not take one out of rotation.
   */
  recordFailure(
    credentialId: string,
    providerId: string,
    code: ErrorCode,
    message: string,
    retryAfterSec?: number | null,
  ): CredentialHealth {
    const prev = this.get(credentialId, providerId);
    const now = this.opts.now();
    const accountFault = isAccountFault(code);
    const consecutive = accountFault ? prev.consecutiveFailures + 1 : prev.consecutiveFailures;

    // An unauthorized key is not a flake: one 401 is the answer, and asking
    // twice more just makes the provider say it three times.
    const trait = traitsFor(code);
    const shouldCool = accountFault && (!trait.retryable || consecutive >= this.opts.failureThreshold || retryAfterSec != null);

    let cooldownUntil = prev.cooldownUntil;
    if (shouldCool) {
      const base = Math.max(trait.cooldownSec * 1000, this.opts.minCooldownMs);
      const escalated = base * 2 ** Math.min(4, Math.max(0, consecutive - this.opts.failureThreshold));
      // The provider's own Retry-After wins when it is longer: it is the only
      // party that knows when the window actually rolls.
      const ms = Math.min(this.opts.maxCooldownMs, Math.max(escalated, (retryAfterSec ?? 0) * 1000));
      cooldownUntil = now + ms;
    }

    const next: CredentialHealth = {
      ...prev,
      providerId: providerId || prev.providerId,
      state: accountFault ? stateFor(code) : prev.state,
      consecutiveFailures: consecutive,
      cooldownUntil,
      lastFailureAt: now,
      lastErrorCode: code,
      // Bounded, and the message has already been redacted upstream — a
      // provider echoing a key fragment into an error must not put it here,
      // where it would be read back out through the API and the UI.
      lastError: message.slice(0, 300),
      updatedAt: now,
    };
    this.health.set(credentialId, next);
    this.emit(next);
    return next;
  }

  /**
   * Record what a provider published about an account's remaining allowance.
   *
   * Only fields the provider actually sent are written. A missing header leaves
   * the previous reading in place rather than overwriting it with null, because
   * a response that says nothing about tokens is not a response that says the
   * token budget is unknown.
   */
  recordRateLimit(credentialId: string, providerId: string, snapshot: RateLimitSnapshot): CredentialQuota[] {
    const now = this.opts.now();
    const written: CredentialQuota[] = [];
    const dims: { dimension: QuotaDimension; limit: number | null; remaining: number | null; resetsAt: number | null }[] = [
      {
        dimension: 'requests',
        limit: snapshot.requestsLimit,
        remaining: snapshot.requestsRemaining,
        resetsAt: snapshot.requestsResetsAt,
      },
      { dimension: 'tokens', limit: snapshot.tokensLimit, remaining: snapshot.tokensRemaining, resetsAt: snapshot.tokensResetsAt },
    ];

    for (const d of dims) {
      if (d.limit == null && d.remaining == null && d.resetsAt == null) continue;
      const key = `${credentialId}|${d.dimension}`;
      const prev = this.quotas.get(key);
      const next: CredentialQuota = {
        credentialId,
        providerId,
        dimension: d.dimension,
        limit: d.limit ?? prev?.limit ?? null,
        remaining: d.remaining ?? prev?.remaining ?? null,
        resetsAt: d.resetsAt ?? prev?.resetsAt ?? null,
        source: 'provider-headers',
        observedAt: now,
      };
      this.quotas.set(key, next);
      written.push(next);
      for (const fn of this.quotaListeners) fn(next);
    }
    return written;
  }

  /** Put an account back into rotation — an operator action. */
  reset(credentialId: string, providerId = ''): CredentialHealth {
    const next = blankCredentialHealth(credentialId, providerId || this.get(credentialId).providerId, this.opts.now());
    this.health.set(credentialId, next);
    for (const key of [...this.quotas.keys()]) {
      if (key.startsWith(`${credentialId}|`)) this.quotas.delete(key);
    }
    this.emit(next);
    return next;
  }

  /** Forget an account entirely — used when the credential itself is deleted. */
  forget(credentialId: string): void {
    this.health.delete(credentialId);
    for (const key of [...this.quotas.keys()]) {
      if (key.startsWith(`${credentialId}|`)) this.quotas.delete(key);
    }
  }

  private emit(h: CredentialHealth): void {
    for (const fn of this.listeners) fn(h);
  }
}
