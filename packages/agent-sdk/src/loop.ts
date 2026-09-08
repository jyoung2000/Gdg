import {
  ZERO_USAGE,
  addUsage,
  newId,
  type AgentDefinition,
  type AIRequest,
  type ChatMessage,
  type FallbackEvent,
  type Logger,
  type ToolCallRecord,
  type Usage,
} from '@meridian/shared';
import type { Executor } from '@meridian/routing-sdk';
import { optimizeContext } from '@meridian/context-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import { executeTool, toolDefinitions, type ToolContext, type ToolRegistry } from './tools.js';

export interface AgentRunInput {
  agent: AgentDefinition;
  /** The instruction for this agent, already scoped to its job. */
  instruction: string;
  /** Context gathered by earlier steps, injected as a system message. */
  context?: string;
  workspaceId: string;
  userId: string | null;
  taskId: string;
  stepId: string;
  /** Overrides the agent's own preferred routing mode. */
  mode?: AIRequest['mode'];
  privacyMode?: AIRequest['privacyMode'];
  allowPaid?: boolean;
  sensitive?: boolean;
  budget?: number | null;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  /** The agent's own summary, from its finish call or its last message. */
  summary: string;
  /** Whether the agent ended by calling finish rather than running out of steps. */
  completed: boolean;
  steps: number;
  usage: Usage;
  toolCalls: ToolCallRecord[];
  filesTouched: string[];
  fallbacks: FallbackEvent[];
  modelId: string | null;
  providerId: string | null;
  latencyMs: number;
  error: string | null;
  /** The full transcript, for a follow-up agent that needs the detail. */
  messages: ChatMessage[];
  /**
   * Prompt tokens the optimiser kept out of this step's calls.
   *
   * Summed across turns, from a real before/after measurement per turn rather
   * than from what any stage believed it saved. Zero on a short step, which is
   * the correct answer: the optimiser declines to touch a prompt small enough
   * that trimming it would be more risk than benefit.
   */
  contextTokensSaved: number;
}

export interface AgentLoopDeps {
  executor: Executor;
  tools: ToolRegistry;
  logger: Logger;
  /**
   * Looks up the window of the model that just served a turn.
   *
   * Optional so a caller can construct a loop without one; without it the
   * optimiser sees an unknown window and stays conservative rather than
   * windowing a conversation against a size it had to guess.
   */
  models?: Pick<ModelRegistry, 'get'>;
  /** Emitted after every model turn and every tool call, for live UI. */
  onEvent?: (event: AgentEvent) => void;
  now?: () => number;
}

export type AgentEvent =
  | { type: 'step-start'; stepId: string; role: string; label: string }
  | { type: 'model-start'; stepId: string; modelId: string; providerId: string }
  | { type: 'text'; stepId: string; delta: string }
  | { type: 'tool-start'; stepId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool-end'; stepId: string; record: ToolCallRecord }
  | { type: 'fallback'; stepId: string; event: FallbackEvent }
  | { type: 'step-end'; stepId: string; summary: string; usage: Usage };

/**
 * The agent loop: model turn, tool calls, repeat.
 *
 * Two properties matter more than anything else here. First, a tool failure is
 * fed back to the model as a tool result rather than thrown, so the agent can
 * correct course — most real agent turns contain at least one failed call.
 * Second, the loop is bounded by the agent's own `maxSteps`, so a model that
 * gets stuck costs a known amount rather than an open-ended one.
 */
export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private readonly now: () => number;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  async run(input: AgentRunInput, toolCtx: Omit<ToolContext, 'taskId' | 'stepId' | 'signal'>): Promise<AgentRunResult> {
    const { agent } = input;
    const started = this.now();
    const log = this.deps.logger.child({ taskId: input.taskId, agent: agent.role });

    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
      ...(input.context ? [{ role: 'system' as const, content: `Context from earlier steps:\n\n${input.context}` }] : []),
      { role: 'user', content: input.instruction },
    ];

    // A tool the registry does not have (web_fetch when web access is off) is
    // dropped rather than advertised, so the model never calls something that
    // cannot work.
    const allowedTools = agent.tools.filter((t) => this.deps.tools.has(t));
    const definitions = toolDefinitions(this.deps.tools, allowedTools);

    const request: AIRequest = {
      modality: 'text',
      taskType: agent.taskType,
      messages,
      mode: input.mode ?? agent.preferredMode,
      pool: agent.pool,
      toolsRequired: definitions.length > 0,
      requiredCapabilities: agent.requiredCapabilities,
      privacyMode: input.privacyMode,
      userId: input.userId,
      workspaceId: input.workspaceId,
      allowPaid: input.allowPaid,
      sensitive: input.sensitive,
      budget: input.budget ?? null,
    };

    let usage = ZERO_USAGE;
    // Tokens the optimiser kept out of the prompt across this step's turns.
    let contextSaved = 0;
    /**
     * The window to optimise against.
     *
     * Which model will serve the next turn is the router's decision and is not
     * known until the call is made, so this tracks the model that served the
     * *previous* turn — in a step that is by construction a run of calls of the
     * same shape, that is the best available estimate. Before the first call
     * there is nothing to go on, and the optimiser treats a null window as
     * "unknown", which means it deduplicates but does not window on a guess.
     */
    let contextModel: { contextLength: number | null; maxOutputTokens: number | null } | null = null;
    const toolCalls: ToolCallRecord[] = [];
    const filesTouched = new Set<string>();
    const fallbacks: FallbackEvent[] = [];
    let modelId: string | null = null;
    let providerId: string | null = null;
    let summary = '';
    let completed = false;
    let steps = 0;
    let error: string | null = null;

    this.deps.onEvent?.({ type: 'step-start', stepId: input.stepId, role: agent.role, label: agent.name });

    try {
      while (steps < agent.maxSteps) {
        if (input.signal?.aborted) {
          error = 'Cancelled';
          break;
        }
        steps += 1;

        // The transcript grows by an assistant turn and a tool result on every
        // pass and is re-sent whole each time, so by turn thirty an agent is
        // paying for twenty-nine copies of output it has finished with. This is
        // the one place in Meridian where context genuinely runs away, and it
        // is why optimisation is applied per turn rather than once at the start.
        //
        // AUTO means a short run is left completely alone: the optimiser
        // declines below its own floor and returns the messages untouched.
        const optimized = optimizeContext({
          messages,
          tools: definitions,
          model: contextModel,
          maxOutputTokens: 4096,
          mode: 'AUTO',
          request: input.instruction,
        });
        if (optimized.report.tokensSaved > 0) {
          log.debug('context optimised', {
            mode: optimized.report.mode,
            before: optimized.report.before,
            after: optimized.report.after,
            saved: optimized.report.tokensSaved,
          });
          contextSaved += optimized.report.tokensSaved;
        }

        const res = await this.deps.executor.chat(
          { ...request, messages: optimized.messages },
          { messages: optimized.messages, tools: definitions, temperature: 0.2, maxTokens: 4096 },
          { taskId: input.taskId, agentRole: agent.role, signal: input.signal },
        );

        modelId = res.modelId;
        providerId = res.providerId;
        const served = this.deps.models?.get(res.modelId);
        if (served) contextModel = { contextLength: served.contextLength, maxOutputTokens: served.maxOutputTokens };
        usage = addUsage(usage, res.value.usage);
        for (const f of res.fallbacks) {
          fallbacks.push(f);
          this.deps.onEvent?.({ type: 'fallback', stepId: input.stepId, event: f });
        }
        this.deps.onEvent?.({ type: 'model-start', stepId: input.stepId, modelId: res.modelId, providerId: res.providerId });

        const assistant: ChatMessage = {
          role: 'assistant',
          content: res.value.content,
          toolCalls: res.value.toolCalls.length ? res.value.toolCalls : undefined,
        };
        messages.push(assistant);
        if (res.value.content) {
          this.deps.onEvent?.({ type: 'text', stepId: input.stepId, delta: res.value.content });
        }

        if (!res.value.toolCalls.length) {
          // No tool calls and no finish: the model has said its piece.
          summary = res.value.content.trim() || summary;
          completed = true;
          break;
        }

        for (const call of res.value.toolCalls) {
          this.deps.onEvent?.({ type: 'tool-start', stepId: input.stepId, name: call.name, arguments: call.arguments });
          const { result, record } = await executeTool(
            call,
            { ...toolCtx, taskId: input.taskId, stepId: input.stepId, signal: input.signal },
            allowedTools,
            this.deps.tools,
          );
          toolCalls.push(record);
          for (const f of result.filesTouched ?? []) filesTouched.add(f);
          this.deps.onEvent?.({ type: 'tool-end', stepId: input.stepId, record });

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result.isError ? `Error: ${result.content}` : result.content,
          });

          if (result.finished) {
            summary = result.content;
            completed = true;
          }
        }

        if (completed) break;
      }

      if (!completed && steps >= agent.maxSteps) {
        error = `Stopped after ${agent.maxSteps} steps without finishing`;
        summary = summary || lastAssistantText(messages) || error;
        log.warn('agent hit step limit', { agent: agent.role, steps });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      summary = summary || lastAssistantText(messages) || '';
      log.error('agent failed', { agent: agent.role, errorCode: error });
    }

    const result: AgentRunResult = {
      summary: summary.trim(),
      completed,
      steps,
      usage,
      toolCalls,
      filesTouched: [...filesTouched],
      fallbacks,
      modelId,
      providerId,
      latencyMs: this.now() - started,
      error,
      messages,
      contextTokensSaved: contextSaved,
    };
    this.deps.onEvent?.({ type: 'step-end', stepId: input.stepId, summary: result.summary, usage });
    return result;
  }
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return '';
}

/** Stable step id, so a resumed task keeps its timeline. */
export function newStepId(): string {
  return newId('step');
}
