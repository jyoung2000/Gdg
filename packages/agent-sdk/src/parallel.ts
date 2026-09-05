import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZERO_USAGE, addUsage, newId, type AgentTask, type Logger, type TaskStep, type Usage } from '@meridian/shared';
import type { Orchestrator, RunTaskInput } from './orchestrator.js';
import { newTask } from './orchestrator.js';
import { Workspace } from './workspace.js';

export interface Lane {
  /** Display name, e.g. "Frontend". */
  name: string;
  request: string;
}

export interface LaneRun {
  lane: string;
  task: AgentTask;
  steps: TaskStep[];
  /** The isolated workspace the lane ran in. */
  workspacePath: string;
  changes: import('@meridian/shared').FileChange[];
  error: string | null;
}

export interface ParallelOptions extends Omit<RunTaskInput, 'task' | 'workspace'> {
  workspaceId: string;
  userId: string | null;
  /** The source workspace every lane starts from. */
  source: Workspace;
  /** Where lane copies are created. */
  scratchRoot: string;
  /** Max lanes in flight. Beyond this, lanes queue. */
  concurrency?: number;
  logger: Logger;
}

/**
 * Run several agents at once, each in its own copy of the workspace.
 *
 * Isolation is the whole point: two agents editing the same checkout produce a
 * result neither of them intended, and the failure is invisible until someone
 * reads the diff. Copying the workspace per lane costs disk and a few seconds,
 * which is cheap next to silently corrupted output.
 *
 * Lanes are not merged automatically. Each lane's diff is presented separately
 * for review, because a machine-merged combination of two independent agents'
 * edits is exactly the kind of change a person must look at.
 */
export class ParallelRunner {
  private readonly orchestrator: Orchestrator;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  async run(lanes: Lane[], opts: ParallelOptions): Promise<LaneRun[]> {
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, lanes.length));
    const results: LaneRun[] = new Array(lanes.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        if (index >= lanes.length) return;
        results[index] = await this.runLane(lanes[index], opts);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }

  private async runLane(lane: Lane, opts: ParallelOptions): Promise<LaneRun> {
    const laneId = newId('lane');
    const path = join(opts.scratchRoot, laneId);
    const log = opts.logger.child({ lane: lane.name });

    try {
      await mkdir(opts.scratchRoot, { recursive: true });
      // node_modules and .git are excluded: they are large, reproducible, and
      // copying .git would let two lanes commit divergent histories under the
      // same identity.
      await cp(opts.source.root, path, {
        recursive: true,
        filter: (src) => !/[/\\](node_modules|\.git|dist|build|\.next|\.turbo|coverage)([/\\]|$)/.test(src),
      });

      const workspace = new Workspace(path);
      const task = newTask({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        request: lane.request,
        lane: lane.name,
        mode: opts.mode,
      });

      const { task: finished, steps } = await this.orchestrator.run({
        ...opts,
        task,
        workspace,
      });

      return {
        lane: lane.name,
        task: finished,
        steps,
        workspacePath: path,
        changes: workspace.pendingChanges(),
        error: finished.error,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('lane failed', { errorCode: message });
      const task = newTask({ workspaceId: opts.workspaceId, userId: opts.userId, request: lane.request, lane: lane.name });
      return {
        lane: lane.name,
        task: { ...task, status: 'failed', error: message, finishedAt: Date.now() },
        steps: [],
        workspacePath: path,
        changes: [],
        error: message,
      };
    }
  }

  /** Remove a lane's scratch workspace once its diff has been dealt with. */
  async discard(workspacePath: string): Promise<void> {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

/** Combined usage across lanes, for the task-economics display. */
export function totalUsage(runs: LaneRun[]): Usage {
  return runs.reduce<Usage>((acc, r) => addUsage(acc, r.task.usage), ZERO_USAGE);
}

/**
 * Paths more than one lane changed.
 *
 * Overlap does not stop anything — the lanes already ran independently — but it
 * is the first thing a reviewer needs to know before applying two lanes' diffs
 * to the same tree.
 */
export function conflictingPaths(runs: LaneRun[]): { path: string; lanes: string[] }[] {
  const byPath = new Map<string, string[]>();
  for (const run of runs) {
    for (const change of run.changes) {
      byPath.set(change.path, [...(byPath.get(change.path) ?? []), run.lane]);
    }
  }
  return [...byPath.entries()]
    .filter(([, lanes]) => lanes.length > 1)
    .map(([path, lanes]) => ({ path, lanes }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
