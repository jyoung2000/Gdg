import type { ErrorCode } from './errors.js';

/**
 * Accounts.
 *
 * Meridian's account is a credential. A provider is a service; a credential is
 * the identity Meridian presents to it, and it is the thing the provider
 * actually meters, rate-limits, bills and revokes. Everything in this file
 * exists because those facts belonged to the credential and were being recorded
 * against the provider instead.
 *
 * The consequence was not cosmetic. `provider_health` is keyed by provider, and
 * the executor recorded every failure there — so one user's revoked key
 * produced an `authentication_failed` that marked the PROVIDER unauthorized,
 * took it out of rotation, and did that for every other user on the instance,
 * whose keys were fine. On a shared install one person's expired card could
 * remove a provider for everybody.
 */

export const CREDENTIAL_STATES = [
  'unknown',
  'healthy',
  /** The provider said slow down. Busy, not broken. */
  'rate_limited',
  /** The allowance for this window is spent. */
  'quota_exhausted',
  /** The provider rejected this identity: revoked, expired, or wrong. */
  'unauthorized',
  /** Failing for a reason that is not obviously about the credential. */
  'failing',
] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/**
 * What is known about one account's standing with its provider.
 *
 * `cooldownUntil` is the operative field: it is the difference between "do not
 * use this key for ninety seconds" and "stop using this key", and both used to
 * be expressed as taking the whole provider offline.
 */
export interface CredentialHealth {
  credentialId: string;
  providerId: string;
  state: CredentialState;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: ErrorCode | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Epoch ms before which this credential should not be chosen again. */
  cooldownUntil: number | null;
  updatedAt: number;
}

export function blankCredentialHealth(credentialId: string, providerId: string, at: number): CredentialHealth {
  return {
    credentialId,
    providerId,
    state: 'unknown',
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
    lastError: null,
    consecutiveFailures: 0,
    cooldownUntil: null,
    updatedAt: at,
  };
}

/**
 * The failures that are about the ACCOUNT rather than the service.
 *
 * This list is the whole multi-tenant fix. A 401 means this key is not welcome;
 * it says nothing about whether the provider is up, and nothing at all about
 * anyone else's key. A 429 and a spent quota are the same shape: the provider is
 * serving fine, this account has run out of room. Attributing any of them to the
 * provider punishes every other caller for one account's problem.
 *
 * Everything else — timeouts, 5xx, a model that vanished — is the provider's,
 * and stays on the provider's breaker where it belongs.
 */
export const ACCOUNT_FAULT_CODES: readonly ErrorCode[] = ['authentication_failed', 'rate_limited', 'quota_exhausted'];

export function isAccountFault(code: ErrorCode): boolean {
  return ACCOUNT_FAULT_CODES.includes(code);
}

/**
 * What a provider last said about how much room is left on an account.
 *
 * Modelled on the headers providers actually send rather than on a tidy
 * abstraction: a window, a ceiling, what is left, and when it resets, recorded
 * separately for requests and for tokens because providers meter those on
 * separate budgets and exhausting either one stops the account.
 *
 * Every measurement is nullable and null is never "plenty". A provider that
 * publishes nothing must leave a router exactly as uninformed as it was, not
 * newly confident.
 */
export interface CredentialQuota {
  credentialId: string;
  providerId: string;
  dimension: QuotaDimension;
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the window resets, when the provider says so. */
  resetsAt: number | null;
  source: QuotaSource;
  observedAt: number;
}

export const QUOTA_DIMENSIONS = ['requests', 'tokens'] as const;
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

export const QUOTA_SOURCES = ['provider-headers', 'provider-api', 'local-accounting', 'unknown'] as const;
export type QuotaSource = (typeof QUOTA_SOURCES)[number];

/**
 * How much of this quota is left, in [0,1], or null when it cannot be said.
 *
 * The `CredentialQuota` sibling of `quotaRemainingFraction`: that one reads a
 * `QuotaState` built from usage counters, this one reads a row observed from a
 * provider's own rate-limit headers.
 *
 * Null rather than 1 when the provider published a remaining count with no
 * limit to measure it against, and null once the reset time has passed —
 * because after a window resets the reading describes the window before it,
 * and a stale zero would keep a recovered account at the back of the queue.
 */
export function quotaFraction(q: CredentialQuota, now: number = Date.now()): number | null {
  if (q.resetsAt !== null && q.resetsAt <= now) return null;
  if (q.remaining === null || q.limit === null || q.limit <= 0) return null;
  return Math.max(0, Math.min(1, q.remaining / q.limit));
}

/** Known-empty. An unpublished quota is never treated as empty. */
export function quotaIsExhausted(q: CredentialQuota): boolean {
  return q.remaining != null && q.remaining <= 0;
}

/**
 * A rate-limit snapshot read off a response.
 *
 * The header names are the de-facto standard the large providers converged on
 * (`x-ratelimit-*`, and the IETF's `ratelimit-*` draft), so one parser covers
 * OpenAI, Anthropic, Groq, OpenRouter and most OpenAI-compatible servers
 * without a per-provider table. Anything unrecognised stays null.
 */
export interface RateLimitSnapshot {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsResetsAt: number | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensResetsAt: number | null;
}

const EMPTY_SNAPSHOT: RateLimitSnapshot = {
  requestsLimit: null,
  requestsRemaining: null,
  requestsResetsAt: null,
  tokensLimit: null,
  tokensRemaining: null,
  tokensResetsAt: null,
};

function num(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * A reset value, which providers express three different ways.
 *
 * Seconds ("60"), a duration with a unit ("1m30s", "500ms"), or an absolute
 * epoch. All three become an absolute epoch in ms, because a duration stored
 * without the moment it was read is not information.
 */
export function parseResetAt(raw: string | null | undefined, now: number): number | null {
  if (raw == null || raw === '') return null;
  const trimmed = raw.trim();

  const plain = Number(trimmed);
  if (Number.isFinite(plain)) {
    // Anything large enough to be a date already is one. The threshold is far
    // above any plausible "seconds until reset" and far below any plausible
    // epoch, so neither reading is ambiguous in practice.
    if (plain > 1e11) return Math.round(plain);
    if (plain > 1e9) return Math.round(plain * 1000);
    return now + Math.max(0, plain) * 1000;
  }

  // Durations like `1h30m`, `6m0s`, `500ms`. `ms` must be matched before `m`,
  // or half a second reads as half a minute.
  const parts = trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g);
  let total = 0;
  let matched = false;
  for (const [, value, unit] of parts) {
    matched = true;
    const n = Number(value);
    total += n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[unit as 'ms' | 's' | 'm' | 'h' | 'd'];
  }
  if (matched) return now + total;

  const asDate = Date.parse(trimmed);
  return Number.isFinite(asDate) ? asDate : null;
}

/** Read the standard rate-limit headers off a response. */
export function readRateLimitHeaders(headers: { get(name: string): string | null }, now: number): RateLimitSnapshot {
  const get = (...names: string[]): string | null => {
    for (const n of names) {
      const v = headers.get(n);
      if (v != null && v !== '') return v;
    }
    return null;
  };

  const snapshot: RateLimitSnapshot = {
    requestsLimit: num(get('x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit', 'ratelimit-limit')),
    requestsRemaining: num(get('x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining', 'ratelimit-remaining')),
    requestsResetsAt: parseResetAt(
      get('x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset', 'ratelimit-reset'),
      now,
    ),
    tokensLimit: num(get('x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit')),
    tokensRemaining: num(get('x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining')),
    tokensResetsAt: parseResetAt(get('x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset'), now),
  };
  return snapshot;
}

/** True when a snapshot carries nothing worth recording. */
export function snapshotIsEmpty(s: RateLimitSnapshot): boolean {
  return (Object.keys(EMPTY_SNAPSHOT) as (keyof RateLimitSnapshot)[]).every((k) => s[k] == null);
}
