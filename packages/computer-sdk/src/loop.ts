import { validateAction } from './policy.js';
import type { ComputerSession } from './session.js';
import type { ComputerAction, PermissionSet, ScreenContext } from './types.js';
import { PERMISSIONS } from './types.js';

/**
 * The observe → plan → validate → approve → execute loop.
 *
 * Deliberately thin. It does not know which model it is talking to, which
 * backend it is driving, or how the picture was captured — those are injected.
 * That is what keeps model and backend genuinely composable rather than
 * pairwise-wired: any model that can look at a screenshot and emit one of
 * Meridian's actions can drive any backend that supports it.
 *
 * Planner/grounding separation informed by:
 *   https://github.com/simular-ai/Agent-S
 */

/** What the loop asks a model for on each step. */
export interface PlanRequest {
  task: string;
  step: number;
  maxSteps: number;
  screenshot: { data: string; width: number; height: number } | null;
  screen: ScreenContext;
  /** Recent actions and their outcomes, oldest first. */
  history: { action: ComputerAction; status: string; result: string | null; error: string | null }[];
  /** The literal permission grant, so the model can plan within it. */
  permissions: PermissionSet;
  /** Actions this backend can perform. */
  supportedActions: string[];
  /** Extra instruction text (skills) resolved by the control plane. */
  systemExtras: string;
}

export interface PlanResult {
  action: ComputerAction;
  /** One-line operational summary. Never private reasoning. */
  summary: string;
  /** Which model produced it, for the session record. */
  modelId: string | null;
}

/** Injected: turns a screen and a task into the next action. */
export type Planner = (request: PlanRequest, signal: AbortSignal) => Promise<PlanResult>;

export interface LoopOptions {
  session: ComputerSession;
  planner: Planner;
  /** Called when the planner fails; returning true means "try again". */
  onPlannerError?: (error: Error, attempt: number) => Promise<boolean>;
}

const HISTORY_WINDOW = 8;
/**
 * How many identical consecutive actions count as stuck.
 *
 * A model that cannot tell its last action had no effect will happily repeat
 * it until the step budget is gone, which wastes the user's money and ends in
 * an unhelpful "step limit reached". Detecting it lets the session stop with
 * an accurate reason instead.
 */
const REPEAT_LIMIT = 3;
/**
 * How long one planning call may take before it is abandoned.
 *
 * Generous, because vision planning over a full screenshot is slow. Not
 * unbounded, because a provider that accepts a request and never answers would
 * otherwise pin the session and its backend open for as long as the socket
 * stayed alive.
 */
const PLAN_TIMEOUT_MS = 120_000;

function sameAction(a: ComputerAction, b: ComputerAction): boolean {
  // Compared by value rather than identity, and ignoring the rationale, since
  // a model often rewords the same step while proposing it unchanged.
  const strip = (x: ComputerAction): string => JSON.stringify({ ...x, rationale: undefined });
  return strip(a) === strip(b);
}

/**
 * Build the prompt-side view of what the agent may do.
 *
 * The model is told its permissions so it plans sensibly, and told plainly
 * that Meridian enforces them regardless. Telling it is a courtesy that
 * improves plans; the enforcement in the policy engine is what actually holds.
 */
export function describePermissions(permissions: PermissionSet): string {
  const lines = PERMISSIONS.map((p) => `${p}: ${permissions[p] === true ? 'allowed' : 'denied'}`);
  return lines.join('\n');
}

export function systemPrompt(request: PlanRequest): string {
  return [
    'You are operating a computer through Meridian on the user\'s behalf.',
    '',
    `Task: ${request.task}`,
    '',
    'You act by returning exactly one action per step as strict JSON. The available actions are:',
    request.supportedActions.map((a) => `- ${a}`).join('\n'),
    '',
    `The screen is ${request.screen.width}x${request.screen.height}. Give coordinates in a ${request.screen.groundingWidth}x${request.screen.groundingHeight} space; Meridian scales them.`,
    '',
    'Your permissions are:',
    describePermissions(request.permissions),
    '',
    'Meridian enforces these permissions itself and will refuse anything outside them, so do not attempt actions you are not permitted to take.',
    '',
    'Respond with ONLY a JSON object of the form:',
    '{"summary": "<one short sentence describing this step>", "action": {"type": "...", ...}}',
    '',
    'The summary is shown to the user. Describe what you are doing, not how you reasoned.',
    'When the task is done, or cannot be done, return {"type":"finish","success":<bool>,"summary":"<what happened>"}.',
    request.systemExtras ? `\n${request.systemExtras}` : '',
  ].join('\n');
}

/** Parse a model reply into an action, tolerating fences and stray prose. */
export function parsePlan(text: string): { action: ComputerAction; summary: string } | { error: string } {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const braced = /\{[\s\S]*\}/.exec(text);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { action?: unknown; summary?: unknown; type?: unknown };
    // Accept both the wrapped shape and a bare action, since models drift
    // between them and refusing the bare form would waste a whole step.
    const rawAction = obj.action ?? (typeof obj.type === 'string' ? obj : null);
    if (!rawAction) continue;
    const validation = validateAction(rawAction);
    if (!validation.ok) return { error: validation.error ?? 'invalid action' };
    const action = rawAction as ComputerAction;
    const summary = typeof obj.summary === 'string' && obj.summary.trim() ? obj.summary.trim() : (action.rationale ?? describeFallback(action));
    return { action, summary };
  }
  return { error: 'the reply did not contain a JSON action' };
}

function describeFallback(action: ComputerAction): string {
  return `Performing ${action.type}`;
}

/**
 * Run the session to completion.
 *
 * Every iteration re-checks the session's terminal state and honours a pause
 * before doing anything, so Stop and Pause take effect between steps as well
 * as during the action they interrupt.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  const { session, planner } = opts;
  const config = session.config;

  try {
    session.start();
    await session.currentBackend().open();

    let lastAction: ComputerAction | null = null;
    let repeats = 0;

    for (let step = 0; step < config.maxSteps; step++) {
      if (session.isTerminal()) return;
      if (!(await session.waitWhilePaused())) return;

      const shot = await session.capture();
      if (session.isTerminal()) return;

      const screen = await session.currentBackend().screen();
      const request: PlanRequest = {
        task: config.task,
        step: step + 1,
        maxSteps: config.maxSteps,
        screenshot: shot ? { data: shot.data, width: shot.width, height: shot.height } : null,
        screen,
        history: session
          .actions()
          .slice(-HISTORY_WINDOW)
          .map((r) => ({ action: r.action, status: r.status, result: r.result, error: r.error })),
        permissions: config.permissions,
        supportedActions: session.currentBackend().supportedActions(),
        systemExtras: '',
      };

      let plan: PlanResult;
      try {
        // Through the session, so Stop aborts the model call itself. A planner
        // awaited outside the kill switch is how a "stopped" session keeps a
        // request in flight and a backend process alive.
        plan = await session.runOp(PLAN_TIMEOUT_MS, (signal) => planner(request, signal));
      } catch (e) {
        // A Stop that landed mid-plan is not a planner failure and must not be
        // reported as one, nor trigger a fallback to another model.
        if (session.isTerminal()) return;
        const error = e instanceof Error ? e : new Error(String(e));
        const retry = opts.onPlannerError ? await opts.onPlannerError(error, step) : false;
        if (retry) continue;
        session.fail(`The model could not produce a next step: ${error.message}`);
        return;
      }

      if (session.isTerminal()) return;
      session.think(plan.summary);
      session.setActiveModel(plan.modelId);

      // Stop a model that is going in circles, before it spends the budget.
      if (plan.action.type !== 'finish' && plan.action.type !== 'wait') {
        if (lastAction && sameAction(lastAction, plan.action)) repeats += 1;
        else repeats = 0;
        lastAction = plan.action;
        if (repeats + 1 >= REPEAT_LIMIT) {
          session.complete(
            false,
            `Stopped after proposing the same ${plan.action.type} action ${REPEAT_LIMIT} times in a row without making progress.`,
          );
          return;
        }
      }

      const record = await session.perform(plan.action);

      if (plan.action.type === 'finish') {
        const finish = plan.action;
        session.complete(finish.success, finish.summary);
        return;
      }

      // A denied action is a decision, not an error: the loop continues so the
      // model can choose a different approach, and the denial is in its history.
      if (record.status === 'failed' && session.isTerminal()) return;
    }

    session.complete(false, `Reached the ${config.maxSteps}-step limit without finishing.`);
  } catch (e) {
    if (!session.isTerminal()) session.fail(e instanceof Error ? e.message : String(e));
  } finally {
    await session.dispose().catch(() => undefined);
  }
}
