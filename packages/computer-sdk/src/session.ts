import { randomUUID } from 'node:crypto';
import { MeridianError } from '@meridian/shared';
import type { ComputerAgentBackend } from './backend.js';
import { describeAction, evaluate } from './policy.js';
import type {
  ActionRecord,
  ActionType,
  AgentEvent,
  ComputerAction,
  ComputerSessionInfo,
  PendingApproval,
  Screenshot,
  SessionConfig,
  SessionState,
} from './types.js';

/**
 * One computer-control session: its state machine, its history, its approval
 * gate and its kill switch.
 *
 * The properties worth stating explicitly, because they are the ones a user's
 * safety depends on:
 *
 *  - Stop actually stops. It aborts the in-flight action's signal and moves the
 *    session to a terminal state, so the loop cannot take another step. It is
 *    not a flag the loop is trusted to check politely.
 *  - Pause blocks before the next action, never mid-action, so the machine is
 *    never left half-way through a drag.
 *  - Approvals expire. A dialog nobody answers must not pin a session open
 *    forever holding a backend.
 */

const MAX_HISTORY = 500;
const MAX_SCREENSHOTS = 40;
const APPROVAL_TTL_MS = 5 * 60_000;

export interface SessionHooks {
  onEvent?: (event: AgentEvent) => void;
  /** Persist a finished action; the gateway backs this with its store. */
  persistAction?: (record: ActionRecord) => void;
  persistSession?: (info: ComputerSessionInfo) => void;
  now?: () => number;
}

export class ComputerSession {
  readonly id: string;
  readonly config: SessionConfig;
  private readonly hooks: SessionHooks;
  private readonly now: () => number;

  private state: SessionState = 'starting';
  private backend: ComputerAgentBackend;
  private activeModelId: string | null;
  private stepCount = 0;
  private readonly history: ActionRecord[] = [];
  private readonly screenshots: Screenshot[] = [];
  private approval: PendingApproval | null = null;
  private approvalResolve: ((granted: boolean) => void) | null = null;
  private approvalTimer: NodeJS.Timeout | null = null;
  /** Action types the user approved for the remainder of the task. */
  private readonly blanketApprovals = new Set<ActionType>();
  private readonly createdAt: number;
  private updatedAt: number;
  private finishedAt: number | null = null;
  private summary: string | null = null;
  private error: string | null = null;

  /** Aborts whatever the backend is doing right now. */
  private currentOp: AbortController | null = null;
  /** Resolves when a paused session is resumed or stopped. */
  private pauseGate: Promise<void> | null = null;
  private pauseRelease: (() => void) | null = null;

  constructor(opts: { config: SessionConfig; backend: ComputerAgentBackend; hooks?: SessionHooks }) {
    this.id = `cs_${randomUUID().slice(0, 12)}`;
    this.config = opts.config;
    this.backend = opts.backend;
    this.activeModelId = opts.config.modelId;
    this.hooks = opts.hooks ?? {};
    this.now = this.hooks.now ?? (() => Date.now());
    this.createdAt = this.now();
    this.updatedAt = this.createdAt;
  }

  /* ---- state ------------------------------------------------------- */

  info(): ComputerSessionInfo {
    return {
      id: this.id,
      state: this.state,
      config: this.config,
      activeBackendId: this.backend.id,
      activeModelId: this.activeModelId,
      step: this.stepCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      finishedAt: this.finishedAt,
      summary: this.summary,
      error: this.error,
      screen: null,
      pendingApproval: this.approval,
    };
  }

  actions(): ActionRecord[] {
    return [...this.history];
  }

  latestScreenshot(): Screenshot | null {
    return this.screenshots[this.screenshots.length - 1] ?? null;
  }

  screenshotById(id: string): Screenshot | null {
    return this.screenshots.find((s) => s.id === id) ?? null;
  }

  isTerminal(): boolean {
    return this.state === 'completed' || this.state === 'failed' || this.state === 'stopped';
  }

  currentBackend(): ComputerAgentBackend {
    return this.backend;
  }

  setState(state: SessionState): void {
    this.state = state;
    this.updatedAt = this.now();
    this.hooks.persistSession?.(this.info());
  }

  setActiveModel(modelId: string | null): void {
    this.activeModelId = modelId;
  }

  /** Swap the backend after a failure, carrying the session identity over. */
  async switchBackend(next: ComputerAgentBackend, reason: string): Promise<void> {
    const from = this.backend.id;
    await this.backend.close().catch(() => undefined);
    this.backend = next;
    await next.open();
    this.emit({ type: 'agent.fallback', sessionId: this.id, at: this.now(), from, to: next.id, reason });
  }

  emit(event: AgentEvent): void {
    this.hooks.onEvent?.(event);
  }

  /* ---- lifecycle --------------------------------------------------- */

  start(): void {
    this.setState('running');
    this.emit({ type: 'agent.started', sessionId: this.id, at: this.now(), config: this.config });
  }

  pause(): boolean {
    if (this.isTerminal() || this.state === 'paused') return false;
    this.setState('paused');
    this.pauseGate = new Promise((resolve) => {
      this.pauseRelease = resolve;
    });
    this.emit({ type: 'agent.paused', sessionId: this.id, at: this.now() });
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused') return false;
    this.setState('running');
    this.pauseRelease?.();
    this.pauseRelease = null;
    this.pauseGate = null;
    this.emit({ type: 'agent.resumed', sessionId: this.id, at: this.now() });
    return true;
  }

  /**
   * Stop for real.
   *
   * Aborts the in-flight backend call, releases anything waiting on a pause or
   * an approval, and moves to a terminal state the loop checks before every
   * step. A session that is stopping can never take another action.
   */
  stop(reason = 'stopped by the user'): void {
    if (this.isTerminal()) return;
    this.setState('stopping');
    this.currentOp?.abort();
    this.pauseRelease?.();
    this.pauseRelease = null;
    this.pauseGate = null;
    this.resolveApproval(false);
    this.setState('stopped');
    this.finishedAt = this.now();
    this.summary = reason;
    this.emit({ type: 'agent.stopped', sessionId: this.id, at: this.now(), reason });
  }

  complete(success: boolean, summary: string): void {
    if (this.isTerminal()) return;
    this.setState(success ? 'completed' : 'failed');
    this.finishedAt = this.now();
    this.summary = summary;
    if (!success) this.error = summary;
    this.emit({ type: 'agent.completed', sessionId: this.id, at: this.now(), success, summary });
  }

  fail(message: string): void {
    if (this.isTerminal()) return;
    this.error = message;
    this.setState('failed');
    this.finishedAt = this.now();
    this.summary = message;
    this.emit({ type: 'agent.error', sessionId: this.id, at: this.now(), message, recoverable: false });
    this.emit({ type: 'agent.completed', sessionId: this.id, at: this.now(), success: false, summary: message });
  }

  /** Block while paused. Returns false when the session ended while waiting. */
  async waitWhilePaused(): Promise<boolean> {
    while (this.state === 'paused' && this.pauseGate) {
      await this.pauseGate;
    }
    return !this.isTerminal();
  }

  /* ---- approvals ---------------------------------------------------- */

  approve(approvalId: string, scope: 'once' | 'task'): boolean {
    if (!this.approval || this.approval.id !== approvalId) return false;
    if (scope === 'task') {
      // Never blanket-approve a destructive action: "approve for this task"
      // must not become a standing licence to delete.
      if (this.approval.verdict.risk !== 'destructive') this.blanketApprovals.add(this.approval.action.type);
    }
    this.resolveApproval(true);
    return true;
  }

  deny(approvalId: string): boolean {
    if (!this.approval || this.approval.id !== approvalId) return false;
    this.resolveApproval(false);
    return true;
  }

  private resolveApproval(granted: boolean): void {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
    const resolve = this.approvalResolve;
    this.approval = null;
    this.approvalResolve = null;
    if (resolve) resolve(granted);
  }

  private async requestApproval(action: ComputerAction, verdict: ReturnType<typeof evaluate>): Promise<boolean> {
    const approval: PendingApproval = {
      id: `ap_${randomUUID().slice(0, 10)}`,
      sessionId: this.id,
      action,
      verdict,
      description: describeAction(action),
      requestedAt: this.now(),
      expiresAt: this.now() + APPROVAL_TTL_MS,
    };
    this.approval = approval;
    this.setState('awaiting_approval');
    this.emit({ type: 'agent.action.approval_required', sessionId: this.id, at: this.now(), approval });

    return new Promise<boolean>((resolve) => {
      this.approvalResolve = resolve;
      // An unanswered dialog denies rather than hangs: holding a backend open
      // indefinitely waiting for a human who left is its own failure mode.
      this.approvalTimer = setTimeout(() => {
        this.emit({
          type: 'agent.error',
          sessionId: this.id,
          at: this.now(),
          message: 'The approval request expired without an answer, so the action was denied.',
          recoverable: true,
        });
        this.resolveApproval(false);
      }, APPROVAL_TTL_MS);
      this.approvalTimer.unref?.();
    });
  }

  /* ---- the guarded execution path ------------------------------------ */

  /**
   * Take one action, all the way through the policy.
   *
   * Everything the mandate calls the policy pipeline happens here in order:
   * validate, check permission, classify risk, ask if required, then execute.
   * There is no path to the backend that skips it.
   */
  async perform(action: ComputerAction): Promise<ActionRecord> {
    const verdict = evaluate({
      action,
      permissions: this.config.permissions,
      approvalMode: this.config.approvalMode,
      blanketApprovals: this.blanketApprovals,
      supportedActions: this.backend.supportedActions(),
    });

    this.stepCount += 1;
    const record: ActionRecord = {
      id: `ar_${randomUUID().slice(0, 10)}`,
      sessionId: this.id,
      step: this.stepCount,
      action,
      verdict,
      status: 'proposed',
      result: null,
      error: null,
      startedAt: this.now(),
      finishedAt: null,
      screenshotId: null,
    };
    this.emit({ type: 'agent.action.proposed', sessionId: this.id, at: this.now(), record });

    if (verdict.decision === 'reject') {
      record.status = 'denied';
      record.error = verdict.reason;
      record.finishedAt = this.now();
      return this.finishRecord(record);
    }

    if (verdict.decision === 'ask') {
      const granted = await this.requestApproval(action, verdict);
      if (this.isTerminal()) {
        record.status = 'skipped';
        record.error = 'the session ended before the action was approved';
        record.finishedAt = this.now();
        return this.finishRecord(record);
      }
      if (!granted) {
        record.status = 'denied';
        record.error = 'denied by the user';
        record.finishedAt = this.now();
        this.setState('running');
        return this.finishRecord(record);
      }
      record.status = 'approved';
      this.setState('running');
    }

    if (this.isTerminal()) {
      record.status = 'skipped';
      record.error = 'the session was stopped';
      record.finishedAt = this.now();
      return this.finishRecord(record);
    }

    record.status = 'executing';
    this.emit({ type: 'agent.action.started', sessionId: this.id, at: this.now(), recordId: record.id });

    const controller = new AbortController();
    this.currentOp = controller;
    const timer = setTimeout(() => controller.abort(), this.config.actionTimeoutMs);
    try {
      record.result = (await this.backend.execute(action, controller.signal)).slice(0, 2000);
      record.status = 'completed';
    } catch (e) {
      record.status = 'failed';
      record.error = controller.signal.aborted
        ? 'the action was cancelled or timed out'
        : e instanceof Error
          ? e.message
          : String(e);
    } finally {
      clearTimeout(timer);
      this.currentOp = null;
    }
    record.finishedAt = this.now();
    return this.finishRecord(record);
  }

  private finishRecord(record: ActionRecord): ActionRecord {
    this.history.push(record);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.hooks.persistAction?.(record);
    this.emit({ type: 'agent.action.completed', sessionId: this.id, at: this.now(), record });
    this.updatedAt = this.now();
    return record;
  }

  /** Capture the screen and publish it, keeping only a bounded window. */
  async capture(): Promise<Screenshot | null> {
    if (this.isTerminal()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const shot = await this.backend.screenshot(controller.signal);
      this.screenshots.push(shot);
      if (this.screenshots.length > MAX_SCREENSHOTS) this.screenshots.splice(0, this.screenshots.length - MAX_SCREENSHOTS);
      this.emit({ type: 'agent.screenshot', sessionId: this.id, at: this.now(), screenshotId: shot.id, width: shot.width, height: shot.height });
      return shot;
    } catch (e) {
      this.emit({
        type: 'agent.error',
        sessionId: this.id,
        at: this.now(),
        message: `Could not capture the screen: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  think(summary: string): void {
    this.emit({ type: 'agent.thinking', sessionId: this.id, at: this.now(), step: this.stepCount, summary });
  }

  async dispose(): Promise<void> {
    this.currentOp?.abort();
    await this.backend.close().catch(() => undefined);
  }
}

/** Owns every live session and guarantees they are cleaned up. */
export class SessionRegistry {
  private readonly sessions = new Map<string, ComputerSession>();

  add(session: ComputerSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): ComputerSession {
    const s = this.sessions.get(id);
    if (!s) throw new MeridianError('invalid_request', `No computer session ${id}`);
    return s;
  }

  find(id: string): ComputerSession | null {
    return this.sessions.get(id) ?? null;
  }

  list(): ComputerSession[] {
    return [...this.sessions.values()];
  }

  async remove(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.stop('session closed');
    await s.dispose();
  }

  /** Stop everything: called on shutdown so no backend process is orphaned. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id)));
  }
}
