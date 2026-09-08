import {
  computeCost,
  isErrorCode,
  MeridianError,
  ZERO_USAGE,
  backoffMs,
  classifyUnknown,
  isAccountFault,
  newId,
  shortId,
  sleep,
  type AIRequest,
  type CompletionRequest,
  type ReasoningEffort,
  type CompletionResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FallbackEvent,
  type ImageRequest,
  type ImageResponse,
  type Logger,
  type SpeechRequest,
  type SpeechResponse,
  type StreamChunk,
  type TranscriptionRequest,
  type TranscriptionResponse,
  type Usage,
  type UsageRecord,
  type VideoRequest,
  type VideoResponse,
} from '@meridian/shared';
import { withRateLimitSink, type AdapterContext, type ProviderRegistry } from '@meridian/provider-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import type { CredentialResolver } from './credentials.js';
import type { CredentialHealthStore } from './credential-health.js';
import type { HealthStore } from './health.js';
import type { PoolManager } from './pools.js';
import { routingSnapshot, type Router } from './router.js';

export interface ExecutorDeps {
  router: Router;
  models: ModelRegistry;
  providers: ProviderRegistry;
  health: HealthStore;
  /**
   * Per-account health. Optional so a bare Executor still constructs, but the
   * gateway always supplies one: without it every account fault is attributed
   * to the provider, which is the bug this exists to fix.
   */
  credentialHealth?: CredentialHealthStore;
  credentials: CredentialResolver;
  pools: PoolManager;
  logger: Logger;
  /** Persist a usage row. Called once per attempt, successful or not. */
  recordUsage?: (row: UsageRecord) => void;
  /** Emitted whenever the engine moves to a different target. */
  onFallback?: (event: FallbackEvent) => void;
  now?: () => number;
  /** Injected for deterministic tests. */
  random?: () => number;
  /** How long a provider stream may go silent before it is abandoned. */
  streamIdleTimeoutMs?: number;
}

export interface ExecuteOptions {
  /** Total attempts across all targets, including the first. */
  retryBudget?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  requestId?: string;
  taskId?: string | null;
  agentRole?: UsageRecord['agentRole'];
  /**
   * The agent step this call belongs to.
   *
   * Recorded alongside the role because they are not the same thing: a pipeline
   * can run one role twice, and attributing an outcome by role alone applies
   * the second run's verdict to the first run's calls.
   */
  stepId?: string | null;
  /** Prompt tokens the optimiser kept out of this call, for the record. */
  contextTokensSaved?: number | null;
  signal?: AbortSignal;
}

/** A completed execution plus everything observability needs. */
export interface ExecutionResult<T> {
  value: T;
  providerId: string;
  modelId: string;
  attempts: number;
  fallbacks: FallbackEvent[];
  routingReason: import('@meridian/shared').RoutingReason;
  totalLatencyMs: number;
}

interface Target {
  providerId: string;
  providerModelId: string;
  credentialId: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Executes a routed request, recovering from provider failures.
 *
 * The retry budget is shared across the whole chain, so a request cannot spend
 * an unbounded amount of time bouncing between providers: three attempts means
 * three attempts total, whether they land on one provider or three. Errors the
 * taxonomy marks as non-retryable are never retried against the same target,
 * and errors marked non-failover stop the chain entirely — a content filter
 * rejection is not fixed by asking a different model.
 */
export class Executor {
  private readonly deps: ExecutorDeps;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
  }

  /* ---------------------------------------------------------------- */
  /* Public entry points, one per modality                            */
  /* ---------------------------------------------------------------- */

  chat(req: AIRequest, completion: Omit<CompletionRequest, 'model'>, opts: ExecuteOptions = {}): Promise<ExecutionResult<CompletionResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.chat) throw new MeridianError('unsupported_capability', 'Adapter cannot chat', { providerId: target.providerId });
      return adapter.chat({ ...this.gateEffort(completion, target), model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: r.ttftMs }));
  }

  /**
   * Drop a reasoning-effort request when the resolved model cannot honour it.
   *
   * This is the capability gate, and it lives here because here is the first
   * point at which the concrete model is known — under AUTO the model is not
   * chosen until routing, so the caller cannot gate it. Sending
   * `reasoning_effort` to a plain chat model makes some providers reject the
   * whole request; dropping it silently is both safer and truer to the user's
   * intent, which was "think harder if you can", not "fail if you can't".
   */
  private gateEffort<T extends { reasoningEffort?: ReasoningEffort }>(completion: T, target: Target): T {
    if (!completion.reasoningEffort) return completion;
    const model = this.deps.models.get(`${target.providerId}:${target.providerModelId}`);
    if (model?.capabilities.includes('reasoning')) return completion;
    const { reasoningEffort: _dropped, ...rest } = completion;
    return rest as T;
  }

  embed(req: AIRequest, embedding: EmbeddingRequest, opts: ExecuteOptions = {}): Promise<ExecutionResult<EmbeddingResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.embed) throw new MeridianError('unsupported_capability', 'Adapter cannot embed', { providerId: target.providerId });
      return adapter.embed({ ...embedding, model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: null }));
  }

  image(req: AIRequest, image: ImageRequest, opts: ExecuteOptions = {}): Promise<ExecutionResult<ImageResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.image) throw new MeridianError('unsupported_capability', 'Adapter cannot generate images', { providerId: target.providerId });
      return adapter.image({ ...image, model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: null }));
  }

  video(req: AIRequest, video: VideoRequest, opts: ExecuteOptions = {}): Promise<ExecutionResult<VideoResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.video) throw new MeridianError('unsupported_capability', 'Adapter cannot generate video', { providerId: target.providerId });
      return adapter.video({ ...video, model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: null }));
  }

  speech(req: AIRequest, speech: SpeechRequest, opts: ExecuteOptions = {}): Promise<ExecutionResult<SpeechResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.speech) throw new MeridianError('unsupported_capability', 'Adapter cannot synthesise speech', { providerId: target.providerId });
      return adapter.speech({ ...speech, model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: null }));
  }

  transcribe(req: AIRequest, t: TranscriptionRequest, opts: ExecuteOptions = {}): Promise<ExecutionResult<TranscriptionResponse>> {
    return this.run(req, opts, async (adapter, target, ctx) => {
      if (!adapter.transcribe) throw new MeridianError('unsupported_capability', 'Adapter cannot transcribe', { providerId: target.providerId });
      return adapter.transcribe({ ...t, model: target.providerModelId, signal: ctx.signal }, ctx);
    }, (r) => ({ usage: r.usage, latencyMs: r.latencyMs, ttftMs: null }));
  }

  /**
   * Streaming chat.
   *
   * Failover is only possible before the first token reaches the caller: once
   * text has been emitted, silently restarting on another model would produce a
   * spliced, incoherent response. After that point a failure is surfaced as an
   * error chunk instead.
   */
  async *chatStream(
    req: AIRequest,
    completion: Omit<CompletionRequest, 'model'>,
    opts: ExecuteOptions = {},
  ): AsyncGenerator<StreamChunk & { meta?: { fallbacks: FallbackEvent[]; routingReason: unknown } }> {
    const requestId = opts.requestId ?? shortId();
    const decision = this.deps.router.route(req);
    const routing = routingSnapshot(decision.routingReason);
    const targets = this.targets(decision);
    const budget = opts.retryBudget ?? Math.min(targets.length + 1, 4);
    const fallbacks: FallbackEvent[] = [];
    const log = this.deps.logger.child({ requestId, taskId: opts.taskId ?? null });

    let attempt = 0;
    let emitted = false;
    /** Characters streamed to the caller, for a usage floor when a stream dies. */
    let emittedChars = 0;

    for (let i = 0; i < targets.length && attempt < budget; i++) {
      const target = targets[i];
      attempt += 1;
      const started = this.now();
      const release = this.acquire(target, req.pool ?? null);
      let usage = ZERO_USAGE;
      let ttftMs: number | null = null;

      try {
        const { adapter, ctx } = this.prepare(target, req, requestId, opts, log);
        if (!adapter.chatStream) throw new MeridianError('unsupported_capability', 'Adapter cannot stream', { providerId: target.providerId });

        // The generator is created inside the sink so the request that carries
        // the rate-limit headers is made under it. Iterating happens after, but
        // the headers arrive with the response, not with the last chunk.
        const stream = withRateLimitSink(this.rateLimitSink(target), () =>
          adapter.chatStream!({ ...this.gateEffort(completion, target), model: target.providerModelId, stream: true, signal: ctx.signal }, ctx),
        );
        for await (const chunk of stream) {
          // A tool call is output the client has acted on just as much as text
          // is — failing over after either would splice two models' answers
          // into one response.
          if ((chunk.type === 'text' || chunk.type === 'tool_call') && !emitted) {
            emitted = true;
            ttftMs = this.now() - started;
          }
          if (chunk.type === 'text') emittedChars += chunk.delta.length;
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'error') {
            // The adapter classified this failure; flattening it to
            // server_error made every streamed failure look retryable.
            throw new MeridianError(isErrorCode(chunk.code) ? chunk.code : 'server_error', chunk.error, {
              providerId: target.providerId,
            });
          }
          if (chunk.type === 'start') {
            yield { ...chunk, meta: { fallbacks, routingReason: decision.routingReason } };
            continue;
          }
          yield chunk;
        }

        this.succeeded(target, this.now() - started);
        this.recordUsage(req, target, opts, requestId, usage, this.now() - started, ttftMs, true, null, fallbacks.length, routing);
        if (req.pool) this.deps.pools.recordSpend(req.pool, usage.cost);
        return;
      } catch (e) {
        const err = classifyUnknown(e, target.providerId, target.providerModelId);

        // Tokens that reached the caller before the failure were still
        // generated and, on a paid model, still charged. Zero would be a lie in
        // the polite direction; an estimate from what was actually streamed is
        // a floor, and the code marks the row as failed either way.
        const partial = usage.totalTokens > 0 ? usage : this.estimatePartialUsage(target, emittedChars);

        const cancelled = err.code === 'cancelled' || opts.signal?.aborted === true;
        if (cancelled) {
          // The caller hung up. Not the provider's fault: no breaker, no
          // fallback — there is nobody left to stream a fallback to.
          this.recordUsage(req, target, opts, requestId, partial, this.now() - started, ttftMs, false, 'cancelled', fallbacks.length, routing);
          if (req.pool) this.deps.pools.recordSpend(req.pool, partial.cost);
          return;
        }

        this.failed(target, err);
        this.recordUsage(req, target, opts, requestId, partial, this.now() - started, ttftMs, false, err.code, fallbacks.length, routing);
        if (req.pool && partial.cost > 0) this.deps.pools.recordSpend(req.pool, partial.cost);

        if (emitted || !err.failover || i === targets.length - 1 || attempt >= budget) {
          // Report the whole chain, not just the last link. A stalled stream
          // that fell through to a rate-limited alternate would otherwise be
          // reported as a rate limit, sending the operator after the wrong
          // problem entirely.
          yield { type: 'error', error: describeChain(err, fallbacks, attempt), code: err.code };
          return;
        }
        const next = targets[i + 1];
        const event = this.fallbackEvent(target, next, err, attempt);
        fallbacks.push(event);
        this.deps.onFallback?.(event);
        log.warn('stream fallback', { providerId: target.providerId, errorCode: err.code, fallback: fallbacks.length });
        await sleep(backoffMs(attempt, 200, 4000, this.random), opts.signal).catch(() => undefined);
      } finally {
        release();
      }
    }
    yield {
      type: 'error',
      error: `Every provider in the fallback chain failed${describeAttempts(fallbacks, attempt)}`,
      code: 'provider_unavailable',
    };
  }

  /* ---------------------------------------------------------------- */
  /* Core loop                                                        */
  /* ---------------------------------------------------------------- */

  private async run<T>(
    req: AIRequest,
    opts: ExecuteOptions,
    call: (adapter: NonNullable<ReturnType<ProviderRegistry['get']>>, target: Target, ctx: AdapterContext) => Promise<T>,
    meter: (result: T) => { usage: import('@meridian/shared').Usage; latencyMs: number; ttftMs: number | null },
  ): Promise<ExecutionResult<T>> {
    const requestId = opts.requestId ?? shortId();
    const startedAll = this.now();
    const decision = this.deps.router.route(req);
    const routing = routingSnapshot(decision.routingReason);
    const targets = this.targets(decision);
    const budget = opts.retryBudget ?? Math.min(targets.length + 1, 4);
    const fallbacks: FallbackEvent[] = [];
    const log = this.deps.logger.child({ requestId, taskId: opts.taskId ?? null });

    let attempt = 0;
    let lastError: MeridianError | null = null;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      // Retry the same target while the error says it is worth retrying, then
      // move on. Both loops draw from the one shared budget.
      let sameTargetTries = 0;

      while (attempt < budget) {
        attempt += 1;
        sameTargetTries += 1;
        const started = this.now();
        const release = this.acquire(target, req.pool ?? null);

        try {
          const { adapter, ctx } = this.prepare(target, req, requestId, opts, log);
          const value = await withRateLimitSink(this.rateLimitSink(target), () => call(adapter, target, ctx));
          const m = meter(value);

          this.succeeded(target, m.latencyMs || this.now() - started);
          this.recordUsage(req, target, opts, requestId, m.usage, m.latencyMs, m.ttftMs, true, null, fallbacks.length, routing);
          // Spend outside a pool is still recorded in usage; it just is not
          // charged against a pool budget the caller never chose.
          if (req.pool) this.deps.pools.recordSpend(req.pool, m.usage.cost);
          log.info('call succeeded', {
            providerId: target.providerId,
            modelId: target.providerModelId,
            latencyMs: m.latencyMs,
            tokens: m.usage.totalTokens,
            cost: m.usage.cost,
            fallback: fallbacks.length,
          });

          return {
            value,
            providerId: target.providerId,
            modelId: target.providerModelId,
            attempts: attempt,
            fallbacks,
            routingReason: decision.routingReason,
            totalLatencyMs: this.now() - startedAll,
          };
        } catch (e) {
          const err = classifyUnknown(e, target.providerId, target.providerModelId);
          lastError = err;

          // The caller walking away is not evidence about the provider. Recording
          // it as a failure would open the circuit breaker against a healthy
          // provider every time a user closes a tab at the wrong moment.
          const cancelled = err.code === 'cancelled' || opts.signal?.aborted === true;
          if (cancelled) {
            this.recordUsage(req, target, opts, requestId, ZERO_USAGE, this.now() - started, null, false, 'cancelled', fallbacks.length, routing);
            throw err;
          }

          this.failed(target, err);
          this.recordUsage(req, target, opts, requestId, ZERO_USAGE, this.now() - started, null, false, err.code, fallbacks.length, routing);
          log.warn('call failed', { providerId: target.providerId, modelId: target.providerModelId, errorCode: err.code });

          // A non-failover error is terminal: no other provider will do better.
          if (!err.failover) throw err;

          const canRetrySame = err.retryable && sameTargetTries < 2 && attempt < budget;
          if (canRetrySame) {
            const waitMs = err.retryAfterSec != null ? Math.min(err.retryAfterSec * 1000, 10_000) : backoffMs(sameTargetTries, 250, 8000, this.random);
            await sleep(waitMs, opts.signal).catch(() => undefined);
            continue;
          }
          break; // Move to the next target.
        } finally {
          release();
        }
      }

      const next = targets[i + 1];
      if (!next || attempt >= budget) break;
      const event = this.fallbackEvent(target, next, lastError, attempt);
      fallbacks.push(event);
      this.deps.onFallback?.(event);
      await sleep(backoffMs(fallbacks.length, 200, 4000, this.random), opts.signal).catch(() => undefined);
    }

    const exhausted = lastError ?? new MeridianError('provider_unavailable', 'No provider could serve the request');
    throw new MeridianError(exhausted.code, `${exhausted.message} (after ${attempt} attempt${attempt === 1 ? '' : 's'} across ${fallbacks.length + 1} target${fallbacks.length ? 's' : ''})`, {
      providerId: exhausted.providerId,
      modelId: exhausted.modelId,
      details: { fallbacks, attempts: attempt },
      cause: exhausted,
    });
  }

  /**
   * A floor for what a dead stream consumed, from the characters that reached
   * the caller. Provider-reported usage always wins when it arrived; this only
   * replaces a zero that everyone knows is wrong.
   */
  private estimatePartialUsage(target: Target, emittedChars: number): Usage {
    if (emittedChars <= 0) return ZERO_USAGE;
    const completionTokens = Math.ceil(emittedChars / 3.7);
    const model = this.deps.models.get(`${target.providerId}:${target.providerModelId}`);
    const cost = model ? computeCost(model.pricing, 0, completionTokens) : 0;
    return { promptTokens: 0, completionTokens, totalTokens: completionTokens, cost };
  }

  /* ---------------------------------------------------------------- */

  private targets(decision: import('@meridian/shared').RoutingDecision): Target[] {
    return [
      { providerId: decision.provider, providerModelId: decision.model, credentialId: decision.credential },
      ...decision.fallbackChain.map((f) => ({ providerId: f.provider, providerModelId: f.model, credentialId: f.credential })),
    ];
  }

  private prepare(
    target: Target,
    req: AIRequest,
    requestId: string,
    opts: ExecuteOptions,
    log: Logger,
  ): { adapter: NonNullable<ReturnType<ProviderRegistry['get']>>; ctx: AdapterContext } {
    const adapter = this.deps.providers.get(target.providerId);
    if (!adapter) {
      throw new MeridianError('provider_unavailable', `No adapter for provider ${target.providerId}`, { providerId: target.providerId });
    }
    const descriptor = adapter.descriptor;
    // The caller's identity travels with the resolution. Without it a
    // user-scoped credential the router chose fails its own ownership check
    // here — the resolver correctly refuses a user credential for an unknown
    // user — and every personally-keyed request dies at execution.
    const identity = { userId: req.userId ?? null, workspaceId: req.workspaceId ?? null };
    const resolved = target.credentialId
      ? this.deps.credentials.resolve(
          { providerId: target.providerId, explicitCredentialId: target.credentialId, ...identity },
          descriptor.auth !== 'none',
        )
      : this.deps.credentials.resolve({ providerId: target.providerId, ...identity }, descriptor.auth !== 'none');

    if (!resolved.credential && descriptor.auth !== 'none') {
      throw new MeridianError('authentication_failed', resolved.reason, { providerId: target.providerId });
    }

    const ctx: AdapterContext = {
      secret: resolved.credential?.secret ?? null,
      logger: log,
      requestId,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      streamIdleTimeoutMs: this.deps.streamIdleTimeoutMs,
      signal: opts.signal,
    };
    return { adapter, ctx };
  }

  private acquire(target: Target, poolId: string | null): () => void {
    const releaseCred = this.deps.credentials.acquire(target.credentialId);
    const releasePool = poolId ? this.deps.pools.acquire(poolId) : () => undefined;
    return () => {
      releaseCred();
      releasePool();
    };
  }

  private fallbackEvent(from: Target, to: Target | undefined, err: MeridianError | null, attempt: number): FallbackEvent {
    const code = err?.code ?? 'provider_unavailable';
    return {
      at: this.now(),
      fromProvider: from.providerId,
      fromModel: from.providerModelId,
      toProvider: to?.providerId ?? null,
      toModel: to?.providerModelId ?? null,
      code,
      message: fallbackMessage(code, from.providerId, to?.providerModelId ?? null),
      attempt,
    };
  }

  /**
   * Where this attempt's rate-limit headers go.
   *
   * An account with no credential has nothing to attribute a reading to — an
   * anonymous endpoint's limits belong to the endpoint, not to us — so the sink
   * discards rather than inventing an account to hold them.
   */
  private rateLimitSink(target: Target): (snapshot: import('@meridian/shared').RateLimitSnapshot) => void {
    const credentialId = target.credentialId;
    const providerId = target.providerId;
    const store = this.deps.credentialHealth;
    if (!credentialId || !store) return () => undefined;
    return (snapshot) => store.recordRateLimit(credentialId, providerId, snapshot);
  }

  /**
   * A call worked: both the service and the account served it.
   */
  private succeeded(target: Target, latencyMs: number): void {
    this.deps.health.recordSuccess(target.providerId, latencyMs);
    if (target.credentialId) this.deps.credentialHealth?.recordSuccess(target.credentialId, target.providerId);
  }

  /**
   * A call failed: decide whose fault it was before recording it.
   *
   * This is the multi-tenant fix. Every failure used to land on the provider's
   * circuit breaker, so one caller's revoked key marked the PROVIDER
   * unauthorized and took it out of rotation for every other caller on the
   * instance — people whose own keys were working. A 401, a 429 and a spent
   * quota are facts about an account, and they now stop at the account.
   *
   * An anonymous endpoint has no account to blame, so its rate limit is the
   * provider's and still opens the provider's breaker. That asymmetry is the
   * point rather than an oversight: with no credential, the provider is the
   * only thing that could be rate-limiting us.
   */
  private failed(target: Target, err: MeridianError): void {
    if (target.credentialId) {
      this.deps.credentialHealth?.recordFailure(target.credentialId, target.providerId, err.code, err.message, err.retryAfterSec);
      if (isAccountFault(err.code)) return;
    }
    this.deps.health.recordFailure(target.providerId, err.code, err.message, err.retryAfterSec);
  }

  private recordUsage(
    req: AIRequest,
    target: Target,
    opts: ExecuteOptions,
    requestId: string,
    usage: import('@meridian/shared').Usage,
    latencyMs: number,
    ttftMs: number | null,
    success: boolean,
    errorCode: string | null,
    fallbackCount: number,
    routing: import('@meridian/shared').RoutingSnapshot | null = null,
  ): void {
    this.deps.recordUsage?.({
      id: newId('use'),
      at: this.now(),
      requestId,
      userId: req.userId ?? null,
      workspaceId: req.workspaceId ?? null,
      taskId: opts.taskId ?? null,
      agentRole: opts.agentRole ?? null,
      stepId: opts.stepId ?? null,
      routing,
      contextTokensSaved: opts.contextTokensSaved ?? null,
      providerId: target.providerId,
      modelId: `${target.providerId}:${target.providerModelId}`,
      credentialId: target.credentialId,
      poolId: req.pool ?? null,
      modality: req.modality,
      taskType: req.taskType,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost: usage.cost,
      latencyMs,
      ttftMs,
      success,
      fallbackCount,
      errorCode,
    });
  }
}

/**
 * The one-sentence explanation shown when a fallback happens. It states what
 * occurred and what is being done about it, without alarming language — a
 * recovered failure is normal operation, not an incident.
 */
export function fallbackMessage(code: string, fromProvider: string, toModel: string | null): string {
  const dest = toModel ? ` Switching to ${toModel}.` : ' No alternate is available.';
  switch (code) {
    case 'rate_limited':
      return `${fromProvider} is rate limited right now.${dest}`;
    case 'quota_exhausted':
      return `${fromProvider}'s quota is used up.${dest}`;
    case 'timeout':
      return `${fromProvider} did not respond in time.${dest}`;
    case 'authentication_failed':
      return `${fromProvider} rejected the credential.${dest}`;
    case 'model_unavailable':
      return `That model is not available on ${fromProvider}.${dest}`;
    case 'server_error':
      return `${fromProvider} returned an error.${dest}`;
    case 'provider_unavailable':
      return `${fromProvider} is unreachable.${dest}`;
    default:
      return `${fromProvider} could not complete the request.${dest}`;
  }
}

/** "…(after 3 attempts across 3 targets: local-a timeout → local-b rate_limited)" */
function describeChain(err: MeridianError, fallbacks: FallbackEvent[], attempt: number): string {
  return `${err.message}${describeAttempts(fallbacks, attempt)}`;
}

function describeAttempts(fallbacks: FallbackEvent[], attempt: number): string {
  const targets = fallbacks.length + 1;
  const trail = fallbacks.length
    ? `: ${fallbacks.map((f) => `${f.fromProvider} ${f.code}`).join(' → ')} → final attempt`
    : '';
  return ` (after ${attempt} attempt${attempt === 1 ? '' : 's'} across ${targets} target${targets === 1 ? '' : 's'}${trail})`;
}
