/**
 * The error taxonomy the fallback engine switches on.
 *
 * Every provider adapter is responsible for translating its own transport and
 * API errors into one of these codes; the router never inspects raw provider
 * errors. `retryable` decides whether the same target is worth another attempt,
 * `failover` decides whether a different target should be tried.
 */
export const ERROR_CODES = [
  'rate_limited',
  'timeout',
  'server_error',
  'quota_exhausted',
  'provider_unavailable',
  'authentication_failed',
  'model_unavailable',
  'unsupported_capability',
  'context_length_exceeded',
  'content_filtered',
  'invalid_request',
  'budget_exceeded',
  'cancelled',
  'no_candidates',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorTrait {
  /** Worth retrying the same provider+model after backoff. */
  retryable: boolean;
  /** Worth trying the next entry in the fallback chain. */
  failover: boolean;
  /** Seconds the provider should be cooled down after this error. */
  cooldownSec: number;
  /** HTTP status the gateway returns to its own clients. */
  status: number;
}

const TRAITS: Record<ErrorCode, ErrorTrait> = {
  rate_limited: { retryable: true, failover: true, cooldownSec: 30, status: 429 },
  timeout: { retryable: true, failover: true, cooldownSec: 10, status: 504 },
  server_error: { retryable: true, failover: true, cooldownSec: 20, status: 502 },
  quota_exhausted: { retryable: false, failover: true, cooldownSec: 900, status: 429 },
  provider_unavailable: { retryable: false, failover: true, cooldownSec: 120, status: 503 },
  authentication_failed: { retryable: false, failover: true, cooldownSec: 600, status: 401 },
  model_unavailable: { retryable: false, failover: true, cooldownSec: 300, status: 404 },
  unsupported_capability: { retryable: false, failover: true, cooldownSec: 0, status: 400 },
  context_length_exceeded: { retryable: false, failover: true, cooldownSec: 0, status: 400 },
  content_filtered: { retryable: false, failover: false, cooldownSec: 0, status: 400 },
  invalid_request: { retryable: false, failover: false, cooldownSec: 0, status: 400 },
  budget_exceeded: { retryable: false, failover: false, cooldownSec: 0, status: 402 },
  cancelled: { retryable: false, failover: false, cooldownSec: 0, status: 499 },
  no_candidates: { retryable: false, failover: false, cooldownSec: 0, status: 503 },
  internal: { retryable: false, failover: false, cooldownSec: 0, status: 500 },
};

export class MeridianError extends Error {
  readonly code: ErrorCode;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly status: number;
  readonly retryable: boolean;
  readonly failover: boolean;
  readonly cooldownSec: number;
  /** Provider-supplied Retry-After, in seconds, when present. */
  readonly retryAfterSec: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      providerId?: string | null;
      modelId?: string | null;
      retryAfterSec?: number | null;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MeridianError';
    this.code = code;
    this.providerId = opts.providerId ?? null;
    this.modelId = opts.modelId ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.details = opts.details ?? {};
    const trait = TRAITS[code];
    this.status = trait.status;
    this.retryable = trait.retryable;
    this.failover = trait.failover;
    this.cooldownSec = opts.retryAfterSec != null ? Math.max(trait.cooldownSec, opts.retryAfterSec) : trait.cooldownSec;
  }

  /** Safe JSON body for an API response — never leaks a cause chain. */
  toResponse(): { error: { code: ErrorCode; message: string; provider: string | null; model: string | null } } {
    return {
      error: { code: this.code, message: this.message, provider: this.providerId, model: this.modelId },
    };
  }
}

export function isMeridianError(e: unknown): e is MeridianError {
  return e instanceof MeridianError;
}

export function traitsFor(code: ErrorCode): ErrorTrait {
  return TRAITS[code];
}

/**
 * Best-effort classification of an unknown throwable. Adapters should classify
 * explicitly; this is the safety net for anything that escapes them.
 */
export function classifyUnknown(e: unknown, providerId?: string, modelId?: string): MeridianError {
  if (isMeridianError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  let code: ErrorCode = 'internal';
  if (e instanceof Error && (e.name === 'AbortError' || lower.includes('abort'))) code = 'cancelled';
  else if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('timed out')) code = 'timeout';
  else if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('econnreset') || lower.includes('fetch failed'))
    code = 'provider_unavailable';
  else if (lower.includes('rate limit') || lower.includes('429')) code = 'rate_limited';
  else if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid api key')) code = 'authentication_failed';
  return new MeridianError(code, msg, { providerId, modelId, cause: e });
}

/** Map an HTTP status from a provider onto our taxonomy. */
export function classifyStatus(status: number, body: string): ErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 402) return 'quota_exhausted';
  if (status >= 500) return 'server_error';
  const lower = body.toLowerCase();
  if (lower.includes('context length') || lower.includes('too many tokens') || lower.includes('maximum context'))
    return 'context_length_exceeded';
  if (lower.includes('quota')) return 'quota_exhausted';
  if (lower.includes('content policy') || lower.includes('safety')) return 'content_filtered';
  return 'invalid_request';
}
