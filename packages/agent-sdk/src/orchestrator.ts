import {
  ZERO_USAGE,
  addUsage,
  estimateTokens,
  newId,
  type AgentRole,
  type AgentTask,
  type FallbackEvent,
  type Logger,
  type RoutingMode,
  type TaskEstimate,
  type TaskStep,
  type Usage,
} from '@meridian/shared';
import type { Executor, Router } from '@meridian/routing-sdk';
import { AGENT_DEFINITIONS, STEP_LABEL } from './agents.js';
import { AgentLoop, newStepId, type AgentEvent, type AgentRunResult } from './loop.js';
import type { Sandbox } from './sandbox.js';
import type { ToolRegistry } from './tools.js';
import { unifiedDiff, type Workspace, type WorkspaceCheckpoint } from './workspace.js';

export interface OrchestratorDeps {
  executor: Executor;
  router: Router;
  tools: ToolRegistry;
  sandbox: Sandbox;
  logger: Logger;
  commandTimeoutMs: number;
  onEvent?: (event: TaskEvent) => void;
  /** Persist a step as it changes, so a reload shows live state. */
  persistStep?: (step: TaskStep) => void;
  persistTask?: (task: AgentTask) => void;
  persistToolCall?: (record: import('@meridian/shared').ToolCallRecord) => void;
  /**
   * Persist a workspace snapshot taken before a step ran.
   *
   * Optional because the agent runtime is usable without a database — but when
   * it is wired up, a run becomes reversible one step at a time.
   */
  persistCheckpoint?: (taskId: string, stepId: string | null, checkpoint: WorkspaceCheckpoint) => void;
  now?: () => number;
}

export type TaskEvent =
  | { type: 'task-update'; task: AgentTask }
  | { type: 'step-update'; step: TaskStep }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'diff'; changes: import('@meridian/shared').FileChange[] };

export interface RunTaskInput {
  task: AgentTask;
  workspace: Workspace;
  mode?: RoutingMode;
  privacyMode?: import('@meridian/shared').PrivacyMode;
  allowPaid?: boolean;
  /** Marks the workspace contents as private, blocking unverified providers. */
  sensitive?: boolean;
  budget?: number | null;
  signal?: AbortSignal;
}

/** The steps a task will run, chosen from the shape of the request. */
export interface Pipeline {
  steps: AgentRole[];
  /** One-sentence explanation shown alongside the estimate. */
  rationale: string;
}

/**
 * Runs a task end to end.
 *
 * The pipeline is chosen rather than fixed: a question about the codebase runs
 * a finder and a researcher and stops; a one-line fix skips planning; a broad
 * change runs the full sequence. Choosing badly costs the user money and time,
 * so the choice is made from the request's shape before any expensive model is
 * involved.
 */
export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly loop: AgentLoop;
  private readonly now: () => number;
  /** Tasks currently running, so they can be cancelled by id. */
  private readonly running = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.loop = new AgentLoop({
      executor: deps.executor,
      tools: deps.tools,
      logger: deps.logger,
      onEvent: (e) => deps.onEvent?.({ type: 'agent', event: e }),
      now: this.now,
    });
  }

  cancel(taskId: string): boolean {
    const ac = this.running.get(taskId);
    if (!ac) return false;
    ac.abort(new Error('cancelled'));
    return true;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /**
   * Decide the pipeline from the request.
   *
   * Keyword shape is a crude signal but a free one, and it is right often
   * enough that spending a model call to classify every request would cost more
   * than the occasional misfire. The user can always override the pipeline.
   */
  planPipeline(request: string): Pipeline {
    const text = request.toLowerCase();
    const isQuestion =
      /^(what|where|how|why|which|who|when|does|do|is|are|can|should|explain|describe|show me|tell me|find)\b/.test(text.trim()) ||
      text.trim().endsWith('?');
    const isDebug = /\b(bug|broken|failing|fails|error|crash|regression|stack trace|exception|debug|fix the)\b/.test(text);
    const isTestOnly = /\b(add tests?|write tests?|test coverage|unit tests?)\b/.test(text) && !/\b(implement|add feature|refactor)\b/.test(text);
    const isTrivial = request.length < 120 && /\b(typo|rename|comment|bump|version|import|format)\b/.test(text);

    if (isQuestion && !/\b(add|implement|create|fix|refactor|change|update|remove|delete)\b/.test(text)) {
      return { steps: ['file-finder', 'researcher'], rationale: 'This reads as a question, so it runs a search and a research pass without changing anything.' };
    }
    if (isDebug) {
      return { steps: ['file-finder', 'debugger', 'tester', 'reviewer'], rationale: 'This describes a failure, so it reproduces and fixes the cause, then verifies.' };
    }
    if (isTestOnly) {
      return { steps: ['file-finder', 'tester', 'reviewer'], rationale: 'This asks for tests, so it goes straight to writing and running them.' };
    }
    if (isTrivial) {
      return { steps: ['file-finder', 'implementer'], rationale: 'This is a small, local change, so planning and review would cost more than they add.' };
    }
    return {
      steps: ['file-finder', 'planner', 'implementer', 'tester', 'reviewer'],
      rationale: 'This is a substantive change, so it runs the full sequence: find, plan, implement, test, review.',
    };
  }

  /**
   * Estimate a task before running it.
   *
   * The estimate is honest about being an estimate. It is computed from the
   * pipeline's shape and the router's actual current choice per step, so
   * "$0.00, FREE-FIRST" means the router really did find free capacity for
   * every step — not that we hope it will.
   */
  estimate(request: string, opts: { mode: RoutingMode; workspaceId: string; userId: string | null; allowPaid: boolean }): TaskEstimate {
    const pipeline = this.planPipeline(request);
    const promptTokens = estimateTokens(request);
    let cost = 0;
    let freeAvailable = true;
    const models = new Set<string>();
    let calls = 0;

    for (const role of pipeline.steps) {
      const agent = AGENT_DEFINITIONS[role];
      // Agents rarely finish in one turn; three is a realistic average across
      // a finder, an implementer and a reviewer.
      const turns = role === 'implementer' || role === 'debugger' ? 6 : role === 'tester' ? 4 : 2;
      calls += turns;
      try {
        const preview = this.deps.router.preview({
          modality: 'text',
          taskType: agent.taskType,
          prompt: request,
          mode: opts.mode === 'AUTO' ? agent.preferredMode : opts.mode,
          pool: agent.pool,
          toolsRequired: true,
          userId: opts.userId,
          workspaceId: opts.workspaceId,
          allowPaid: opts.allowPaid,
        });
        const top = preview.candidates[0];
        if (!top) {
          freeAvailable = false;
          continue;
        }
        models.add(top.modelId);
        if (!top.free) freeAvailable = false;
        cost += top.estimatedCost * turns;
      } catch {
        // No candidate for this step is itself information: the estimate says
        // free capacity is not available rather than silently reporting $0.
        freeAvailable = false;
      }
    }

    return {
      calls,
      models: models.size,
      tokens: promptTokens * calls * 4,
      seconds: calls * 8,
      cost: Math.round(cost * 1e4) / 1e4,
      strategy: opts.mode,
      freeAvailable,
      note: pipeline.rationale,
    };
  }

  /** Run a task to completion. Resolves with the finished task record. */
  async run(input: RunTaskInput): Promise<{ task: AgentTask; steps: TaskStep[] }> {
    const ac = new AbortController();
    const signal = input.signal ? anySignal([input.signal, ac.signal]) : ac.signal;
    this.running.set(input.task.id, ac);

    const pipeline = this.planPipeline(input.task.request);
    const log = this.deps.logger.child({ taskId: input.task.id, workspaceId: input.task.workspaceId });

    let task: AgentTask = { ...input.task, status: 'running', startedAt: this.now() };
    this.publishTask(task);

    const steps: TaskStep[] = pipeline.steps.map((role, i) => ({
      id: newStepId(),
      taskId: task.id,
      label: STEP_LABEL[role],
      role,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      summary: null,
      modelId: null,
      providerId: null,
      latencyMs: null,
      usage: null,
      toolCallCount: 0,
      filesTouched: [],
      error: null,
      fallbackEvents: [],
      order: i,
    }));
    for (const s of steps) this.publishStep(s);

    const toolCtx = {
      workspace: input.workspace,
      sandbox: this.deps.sandbox,
      commandTimeoutMs: this.deps.commandTimeoutMs,
      onRecord: this.deps.persistToolCall,
    };

    let usage: Usage = ZERO_USAGE;
    const context: string[] = [];
    let failed: string | null = null;

    try {
      for (let i = 0; i < steps.length; i++) {
        if (signal.aborted) {
          failed = 'Cancelled';
          break;
        }
        const step = steps[i];
        const role = step.role;
        const agent = AGENT_DEFINITIONS[role];

        steps[i] = { ...step, status: 'running', startedAt: this.now() };
        this.publishStep(steps[i]);

        // Snapshot before the step, not after: the point of a checkpoint is the
        // state to come back to if this step goes wrong.
        if (this.deps.persistCheckpoint) {
          try {
            const checkpoint = await input.workspace.checkpoint(`Before ${STEP_LABEL[role]}`);
            this.deps.persistCheckpoint(task.id, step.id, checkpoint);
          } catch (e) {
            // A checkpoint that cannot be taken must not stop the work; it means
            // this step is not reversible, which the checkpoint list will show
            // by simply not containing it.
            log.warn('checkpoint failed', { stepId: step.id, errorCode: e instanceof Error ? e.message : String(e) });
          }
        }

        const result = await this.loop.run(
          {
            agent,
            instruction: this.instructionFor(role, input.task.request, input.workspace),
            context: context.length ? context.join('\n\n---\n\n') : undefined,
            workspaceId: task.workspaceId,
            userId: task.userId,
            taskId: task.id,
            stepId: step.id,
            mode: input.mode,
            privacyMode: input.privacyMode,
            allowPaid: input.allowPaid,
            sensitive: input.sensitive,
            budget: input.budget,
            signal,
          },
          toolCtx,
        );

        usage = addUsage(usage, result.usage);
        steps[i] = {
          ...steps[i],
          status: result.error ? 'failed' : 'completed',
          finishedAt: this.now(),
          summary: summarise(result),
          modelId: result.modelId,
          providerId: result.providerId,
          latencyMs: result.latencyMs,
          usage: result.usage,
          toolCallCount: result.toolCalls.length,
          filesTouched: result.filesTouched,
          error: result.error,
          fallbackEvents: result.fallbacks,
        };
        this.publishStep(steps[i]);

        if (result.summary) context.push(`## ${agent.name}\n${result.summary}`);

        // A failed finder or planner leaves later steps with nothing to work
        // from, so the task stops rather than burning budget on a blind attempt.
        if (result.error && (role === 'file-finder' || role === 'planner' || role === 'implementer' || role === 'debugger')) {
          failed = `${agent.name} failed: ${result.error}`;
          for (let j = i + 1; j < steps.length; j++) {
            steps[j] = { ...steps[j], status: 'skipped' };
            this.publishStep(steps[j]);
          }
          break;
        }
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      log.error('task failed', { errorCode: failed });
    } finally {
      this.running.delete(input.task.id);
    }

    const changes = input.workspace.pendingChanges();
    if (changes.length) this.deps.onEvent?.({ type: 'diff', changes });

    task = {
      ...task,
      status: signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed',
      finishedAt: this.now(),
      error: failed,
      usage,
      result: buildResult(context, changes),
    };
    this.publishTask(task);
    log.info('task finished', { status: task.status, cost: usage.cost, tokens: usage.totalTokens });
    return { task, steps };
  }

  /** The instruction each role receives. Scoped so an agent stays in its lane. */
  private instructionFor(role: AgentRole, request: string, workspace: Workspace): string {
    switch (role) {
      case 'file-finder':
        return `Find the files relevant to this request. The workspace root is ${workspace.root}.\n\nRequest:\n${request}`;
      case 'planner':
        return `Produce a concrete plan for this request, grounded in the files identified above.\n\nRequest:\n${request}`;
      case 'implementer':
        return `Implement this request. Follow the plan above where one was produced.\n\nRequest:\n${request}`;
      case 'tester':
        return `Write and run tests covering the change described above. Report the real test output.\n\nOriginal request:\n${request}`;
      case 'reviewer':
        return `Review the change made above using show_diff. Report concrete defects, or confirm it is sound.\n\nOriginal request:\n${request}`;
      case 'debugger':
        return `Reproduce and fix this failure.\n\nReport:\n${request}`;
      case 'researcher':
        return `Answer this question about the codebase, citing the files you read.\n\nQuestion:\n${request}`;
      default:
        return request;
    }
  }

  private publishTask(task: AgentTask): void {
    this.deps.persistTask?.(task);
    this.deps.onEvent?.({ type: 'task-update', task });
  }

  private publishStep(step: TaskStep): void {
    this.deps.persistStep?.(step);
    this.deps.onEvent?.({ type: 'step-update', step });
  }
}

/**
 * A concise execution summary — what the agent did and what it produced. This
 * is deliberately the agent's own stated conclusion plus counted facts, never
 * an attempt to surface internal reasoning.
 */
function summarise(result: AgentRunResult): string {
  if (result.error && !result.summary) return result.error;
  const facts: string[] = [];
  if (result.filesTouched.length) facts.push(`${result.filesTouched.length} file${result.filesTouched.length === 1 ? '' : 's'} changed`);
  if (result.toolCalls.length) facts.push(`${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? '' : 's'}`);
  const suffix = facts.length ? `\n\n(${facts.join(', ')})` : '';
  return `${result.summary}${suffix}`.trim();
}

function buildResult(context: string[], changes: import('@meridian/shared').FileChange[]): string {
  const parts = [...context];
  if (changes.length) {
    parts.push(`## Changes\n${changes.map((c) => `- ${c.path} (${c.kind}, +${c.additions} −${c.deletions})`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Diff text for the whole task, for the review surface and for a commit body. */
export function taskDiff(changes: import('@meridian/shared').FileChange[]): string {
  return changes.map((c) => unifiedDiff(c.path, c.before, c.after)).join('\n\n');
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export function newTask(input: {
  workspaceId: string;
  userId: string | null;
  request: string;
  lane?: string | null;
  mode?: RoutingMode;
}): AgentTask {
  return {
    id: newId('task'),
    workspaceId: input.workspaceId,
    userId: input.userId,
    title: titleFor(input.request),
    request: input.request,
    status: 'queued',
    lane: input.lane ?? null,
    mode: input.mode ?? 'AUTO',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    estimate: null,
    usage: ZERO_USAGE,
    result: null,
  };
}

/** First clause of the request, capped — enough to recognise it in a list. */
export function titleFor(request: string): string {
  const firstLine = request.trim().split('\n')[0].trim();
  const clipped = firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}…` : firstLine;
  return clipped || 'Untitled task';
}

export type { FallbackEvent };
