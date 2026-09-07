import type { ContentPart, Logger, ModelDescriptor } from '@meridian/shared';
import { MeridianError } from '@meridian/shared';
import {
  AgentSBackend,
  BackendRegistry,
  BrowserComputerBackend,
  ComputerSession,
  NativeComputerBackend,
  SessionRegistry,
  UITarsBackend,
  parsePlan,
  route,
  runLoop,
  systemPrompt,
  SAFE_PERMISSIONS,
  type ActionRecord,
  type AgentEvent,
  type ComputerSessionInfo,
  type PlanRequest,
  type PlanResult,
  type RoutingCandidate,
  type SessionConfig,
} from '@meridian/computer-sdk';
import type { BrowserManager } from '@meridian/browser-sdk';
import type { Executor } from '@meridian/routing-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import type { ProviderRegistry } from '@meridian/provider-sdk';
import type { CredentialResolver, HealthStore } from '@meridian/routing-sdk';

/**
 * The computer agent service.
 *
 * This is the join between Meridian's model layer and the computer-control
 * layer, and it is deliberately the only place they meet. The planner below is
 * the whole of the coupling: it turns a screen into a model call through the
 * ordinary router and turns the reply back into a normalized action. Because
 * that is all, any model the registry knows about can drive any backend the
 * registry knows about — there is nowhere for a model-to-backend mapping to
 * hide.
 */

export interface ComputerServiceDeps {
  executor: Executor;
  models: ModelRegistry;
  providers: ProviderRegistry;
  credentials: CredentialResolver;
  health: HealthStore;
  browser: BrowserManager;
  logger: Logger;
  onEvent: (event: AgentEvent) => void;
  persistSession: (info: ComputerSessionInfo) => void;
  persistAction: (record: ActionRecord) => void;
  /** Extra system text (resolved skills) for a session's model calls. */
  skillPrompt?: (modelId: string | null) => string;
  /** The coordinate space models are asked to point in; null means real pixels. */
  grounding?: { width: number; height: number } | null;
  /** Where the browser surface opens, when one is configured. */
  startUrl?: string | null;
}

export class ComputerService {
  readonly backends = new BackendRegistry();
  readonly sessions = new SessionRegistry();
  private readonly deps: ComputerServiceDeps;
  private readonly sweeper: NodeJS.Timeout;

  constructor(deps: ComputerServiceDeps) {
    this.deps = deps;

    // Finished sessions hold screenshots and, until disposed, a backend. Left
    // alone they accumulate for the life of the process.
    this.sweeper = setInterval(() => this.sessions.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();

    // Registration is unconditional; availability is probed per request. A
    // backend that is missing must appear in the list as unavailable with a
    // reason, not vanish — otherwise the UI cannot explain why it is absent.
    const grounding = deps.grounding ?? null;
    this.backends.register(
      new NativeComputerBackend({
        groundingWidth: grounding?.width,
        groundingHeight: grounding?.height,
      }),
    );
    this.backends.register(
      new BrowserComputerBackend({
        manager: deps.browser,
        groundingWidth: grounding?.width,
        groundingHeight: grounding?.height,
        startUrl: deps.startUrl ?? null,
      }),
    );
    this.backends.register(new AgentSBackend());
    this.backends.register(new UITarsBackend());
  }

  /** Model candidates with the availability facts routing needs. */
  private candidates(): RoutingCandidate[] {
    return this.deps.models.all().map((model: ModelDescriptor) => {
      const descriptor = this.deps.providers.descriptor(model.providerId);
      const credentialed = descriptor ? descriptor.auth === 'none' || this.deps.credentials.hasAny(model.providerId) : false;
      const enabled = this.deps.providers.isEnabled(model.providerId);
      const health = this.deps.health.get(model.providerId);
      const performance = this.deps.models.getPerformance(model.id);
      return {
        model,
        available: Boolean(descriptor) && credentialed && enabled && (!health || health.circuit !== 'open'),
        local: Boolean(descriptor?.local),
        latencyMs: performance?.latencyMs ?? null,
        costPerMTok: model.pricing.outputPerMTok ?? (model.pricing.kind === 'LOCAL' || model.pricing.kind === 'FREE' ? 0 : null),
      };
    });
  }

  async describeBackends() {
    return this.backends.describe();
  }

  /** Decide model + backend + grounding, with the reasoning attached. */
  async plan(input: {
    modelId?: string | null;
    backendId?: string | null;
    groundingMode?: SessionConfig['groundingMode'];
    privacyPreference?: SessionConfig['privacyPreference'];
  }) {
    return route({
      candidates: this.candidates(),
      backends: await this.backends.describe(),
      privacyPreference: input.privacyPreference ?? 'balanced',
      requestedModelId: input.modelId ?? null,
      requestedBackendId: input.backendId ?? null,
      groundingMode: input.groundingMode ?? 'auto',
      costSensitive: true,
    });
  }

  /**
   * Start a session.
   *
   * Routing happens here and its result is frozen into the session's config,
   * so the record of what ran stays true after the defaults change.
   */
  async start(input: {
    task: string;
    modelId?: string | null;
    backendId?: string | null;
    groundingMode?: SessionConfig['groundingMode'];
    permissions?: SessionConfig['permissions'];
    approvalMode?: SessionConfig['approvalMode'];
    privacyPreference?: SessionConfig['privacyPreference'];
    maxSteps?: number;
    actionTimeoutMs?: number;
    profileId?: string | null;
    workspaceId?: string | null;
    /** Who is starting it, so the session is owned from its first stored row. */
    userId?: string | null;
  }): Promise<ComputerSession> {
    if (!input.task.trim()) throw new MeridianError('invalid_request', 'A task is required');

    const decision = await this.plan(input);
    if (decision.error || !decision.backendId) {
      throw new MeridianError('unsupported_capability', decision.error ?? 'No usable computer configuration');
    }

    const registered = this.backends.get(decision.backendId);
    if (!registered) throw new MeridianError('invalid_request', `No backend ${decision.backendId}`);

    // A backend with a single surface — the machine's own desktop — cannot be
    // shared: two agents fighting over one pointer is never what was wanted,
    // and it is better to say so than to let them interleave clicks.
    const perSession = registered.forSession?.() ?? registered;
    if (perSession === registered) {
      const conflict = this.sessions.list().find((s) => !s.isTerminal() && s.currentBackend() === registered);
      if (conflict) {
        throw new MeridianError(
          'invalid_request',
          `The ${registered.name} backend has only one surface and session ${conflict.id} is using it. Stop that session first.`,
        );
      }
    }
    const backend = perSession;

    const config: SessionConfig = {
      task: input.task.trim(),
      backendId: decision.backendId,
      modelId: decision.modelId,
      providerId: decision.modelId ? (this.deps.models.get(decision.modelId)?.providerId ?? null) : null,
      groundingMode: input.groundingMode ?? 'auto',
      groundingModelId: decision.groundingModelId,
      // Nothing is granted implicitly: an absent permission set means the safe
      // default, not "everything the backend can do".
      permissions: input.permissions ?? SAFE_PERMISSIONS,
      approvalMode: input.approvalMode ?? 'risky_actions',
      maxSteps: Math.max(1, Math.min(input.maxSteps ?? 40, 200)),
      actionTimeoutMs: Math.max(1000, Math.min(input.actionTimeoutMs ?? 30_000, 120_000)),
      routingReason: [decision.reason, ...decision.factors].join(' · '),
      fallbackModelIds: decision.fallbackModelIds,
      fallbackBackendIds: decision.fallbackBackendIds,
      profileId: input.profileId ?? null,
      workspaceId: input.workspaceId ?? null,
      privacyPreference: input.privacyPreference ?? 'balanced',
    };

    const session = new ComputerSession({
      config,
      backend,
      userId: input.userId ?? null,
      hooks: {
        onEvent: this.deps.onEvent,
        persistAction: this.deps.persistAction,
        persistSession: this.deps.persistSession,
      },
    });
    this.sessions.add(session);

    // The loop runs detached: the caller gets the session id immediately and
    // watches the event stream, exactly as a long task should behave.
    void runLoop({
      session,
      planner: this.planner(session),
      onPlannerError: async (error, attempt) => this.handlePlannerError(session, error, attempt),
    }).catch((e: unknown) => {
      this.deps.logger.warn('computer session ended abnormally', { detail: e instanceof Error ? e.message : String(e) });
    });

    return session;
  }

  /**
   * The planner: a screen in, one normalized action out.
   *
   * Vision is how this works — the screenshot is attached as an image part, so
   * the model sees what the user sees. That is also why routing requires the
   * vision capability rather than treating it as a nice-to-have.
   */
  private planner(session: ComputerSession) {
    return async (request: PlanRequest, signal: AbortSignal): Promise<PlanResult> => {
      const modelId = session.info().activeModelId;
      const extras = this.deps.skillPrompt?.(modelId) ?? '';
      const system = systemPrompt({ ...request, systemExtras: extras });

      const history = request.history
        .map((h) => `- ${h.action.type}: ${h.status}${h.result ? ` (${h.result})` : ''}${h.error ? ` [${h.error}]` : ''}`)
        .join('\n');

      // The screenshot travels as a data: URL image part, which is the shape
      // every vision adapter in the provider layer already understands.
      const content: ContentPart[] = [
        {
          type: 'text',
          text: [
            `Step ${request.step} of ${request.maxSteps}.`,
            history ? `\nWhat you have done so far:\n${history}` : '\nThis is the first step.',
            request.screenshot ? '\nThe current screen is attached.' : '\nNo screenshot is available this step.',
          ].join('\n'),
        },
      ];
      if (request.screenshot) {
        content.push({ type: 'image', url: `data:image/png;base64,${request.screenshot.data}`, mimeType: 'image/png' });
      }

      const result = await this.deps.executor.chat(
        {
          modality: 'text',
          taskType: 'tool-use',
          model: modelId,
          provider: null,
          pool: null,
          // A computer session is interactive and stateful; quality matters
          // more than shaving a fraction of a cent off each step.
          mode: 'QUALITY_FIRST',
          userId: null,
          workspaceId: session.config.workspaceId,
          requiredCapabilities: ['vision'],
        },
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          maxTokens: 700,
          temperature: 0,
        },
        { signal },
      );

      const parsed = parsePlan(result.value.content ?? '');
      if ('error' in parsed) {
        throw new MeridianError('server_error', `The model did not return a usable action: ${parsed.error}`);
      }
      return { action: parsed.action, summary: parsed.summary, modelId: result.modelId };
    };
  }

  /**
   * A planner failure is where fallback happens.
   *
   * Only the *planning* is retried. An action that already reached the host is
   * never replayed automatically — repeating a half-completed destructive step
   * because the next model call failed is exactly the behaviour the mandate
   * forbids.
   */
  private async handlePlannerError(session: ComputerSession, error: Error, attempt: number): Promise<boolean> {
    const info = session.info();
    session.emit({
      type: 'agent.error',
      sessionId: session.id,
      at: Date.now(),
      message: `Planning failed: ${error.message}`,
      recoverable: attempt < 2,
    });

    if (attempt >= 2) return false;

    const nextModel = info.config.fallbackModelIds[attempt];
    if (nextModel) {
      session.emit({
        type: 'agent.fallback',
        sessionId: session.id,
        at: Date.now(),
        from: info.activeModelId ?? 'auto',
        to: nextModel,
        reason: error.message,
      });
      session.setActiveModel(nextModel);
      return true;
    }

    const nextBackendId = info.config.fallbackBackendIds[attempt];
    const nextBackend = nextBackendId ? this.backends.get(nextBackendId) : null;
    if (nextBackend) {
      await session.switchBackend(nextBackend, error.message).catch(() => undefined);
      return true;
    }
    return false;
  }

  async stopAll(): Promise<void> {
    clearInterval(this.sweeper);
    await this.sessions.closeAll();
    // Belt and braces: a health probe or a crashed session must never leave a
    // helper process holding a display after the gateway has shut down.
    await Promise.all(this.backends.list().map((b) => b.close().catch(() => undefined)));
  }
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

