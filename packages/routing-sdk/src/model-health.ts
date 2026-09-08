import { traitsFor, type ErrorCode } from '@meridian/shared';

/**
 * Health per model, the third and last thing a failure can be about.
 *
 * Meridian now separates the three subjects a failed call can be evidence for,
 * and it took three passes to notice they were three:
 *
 * - the **service** — a timeout, a 5xx, an unreachable host,
 * - the **account** — a 401, a 429, a spent quota,
 * - and the **model** — a name the provider no longer serves, or one it will
 *   not do this kind of work with.
 *
 * All three used to land on the provider's circuit breaker, which meant a
 * single retired model id took an entire provider offline for five minutes.
 * `model_unavailable` is not retryable, so one 404 opened the breaker
 * immediately — and every other model on that provider, working perfectly,
 * became unroutable. Providers retire model ids constantly; a stale entry in a
 * cached catalog was enough to trigger it.
 */

export interface ModelHealthOptions {
  failureThreshold: number;
  minCooldownMs: number;
  maxCooldownMs: number;
  now: () => number;
}

const DEFAULTS: ModelHealthOptions = {
  failureThreshold: 2,
  minCooldownMs: 30_000,
  // A retired model does not come back in a minute, and re-checking it costs a
  // request every time. Longer than the provider breaker's ceiling on purpose.
  maxCooldownMs: 30 * 60_000,
  now: () => Date.now(),
};

export interface ModelHealth {
  modelId: string;
  providerId: string;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  lastErrorCode: ErrorCode | null;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

/**
 * The failures that are about this MODEL rather than the provider or the key.
 *
 * `model_unavailable` is a 404 on the model path: the provider is answering,
 * the credential is fine, and this name is not something it serves.
 * `unsupported_capability` is the provider refusing this kind of work for this
 * model — the tested negative a probe would record, arriving as an error.
 *
 * `context_length_exceeded` is deliberately NOT here. That is a fact about the
 * request, not the model: the same model serves the next, shorter request
 * perfectly, and cooling it down would remove a working model because one
 * caller sent too much.
 */
const MODEL_FAULT_CODES: readonly ErrorCode[] = ['model_unavailable', 'unsupported_capability'];

export function isModelFault(code: ErrorCode): boolean {
  return MODEL_FAULT_CODES.includes(code);
}

function blank(modelId: string, providerId: string): ModelHealth {
  return {
    modelId,
    providerId,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastErrorCode: null,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
}

export class ModelHealthStore {
  private readonly opts: ModelHealthOptions;
  private readonly health = new Map<string, ModelHealth>();

  constructor(opts: Partial<ModelHealthOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get(modelId: string, providerId = ''): ModelHealth {
    const existing = this.health.get(modelId);
    if (existing) return existing;
    const fresh = blank(modelId, providerId);
    this.health.set(modelId, fresh);
    return fresh;
  }

  all(): ModelHealth[] {
    return [...this.health.values()];
  }

  /** Should this model be offered right now? Unknown is always yes. */
  available(modelId: string): boolean {
    const h = this.health.get(modelId);
    return !(h?.cooldownUntil != null && this.opts.now() < h.cooldownUntil);
  }

  /** Why a model is out of rotation, in words a router can put in a rejection. */
  unavailableReason(modelId: string): string | null {
    if (this.available(modelId)) return null;
    const h = this.health.get(modelId);
    const secs = Math.ceil(((h?.cooldownUntil ?? 0) - this.opts.now()) / 1000);
    return h?.lastErrorCode === 'unsupported_capability'
      ? `The provider refused this work for this model; retrying in ${secs}s`
      : `The provider no longer serves this model; retrying in ${secs}s`;
  }

  recordSuccess(modelId: string, providerId: string): void {
    const prev = this.get(modelId, providerId);
    this.health.set(modelId, {
      ...prev,
      providerId: providerId || prev.providerId,
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSuccessAt: this.opts.now(),
    });
  }

  /**
   * Record a failure against the model.
   *
   * Only a model fault moves anything. Everything else updates the last-seen
   * fields and stops — a provider outage says nothing about which model ids are
   * still valid, and cooling every model on a provider having a bad minute
   * would leave nothing to fall back to when it recovers.
   */
  recordFailure(modelId: string, providerId: string, code: ErrorCode, message: string): ModelHealth {
    const prev = this.get(modelId, providerId);
    const now = this.opts.now();
    const fault = isModelFault(code);
    const consecutive = fault ? prev.consecutiveFailures + 1 : prev.consecutiveFailures;
    const trait = traitsFor(code);
    const shouldCool = fault && (!trait.retryable || consecutive >= this.opts.failureThreshold);

    const next: ModelHealth = {
      ...prev,
      providerId: providerId || prev.providerId,
      consecutiveFailures: consecutive,
      cooldownUntil: shouldCool
        ? now +
          Math.min(
            this.opts.maxCooldownMs,
            Math.max(this.opts.minCooldownMs, trait.cooldownSec * 1000) * 2 ** Math.min(3, consecutive - 1),
          )
        : prev.cooldownUntil,
      lastErrorCode: code,
      lastError: message.slice(0, 300),
      lastFailureAt: now,
    };
    this.health.set(modelId, next);
    return next;
  }

  /** Put a model back into rotation — an operator action, or a rediscovery. */
  reset(modelId: string): void {
    this.health.delete(modelId);
  }
}
