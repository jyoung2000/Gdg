import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, newId, type AgentTask, type TaskStep } from '@meridian/shared';
import { newTask } from '@meridian/agent-sdk';
import { startMockProvider } from '../helpers/mock-provider.js';
import { App } from '../../apps/gateway/src/services/app.js';

/**
 * What happens to a task when Meridian stops.
 *
 * Tasks execute detached — `void orchestrator.run(...)` — because a real task
 * outlives any sensible HTTP timeout. Nothing held the resulting promise, so
 * shutdown tore the database out from under tasks that were still working:
 * their ending was never written, and the row stayed `running` forever.
 *
 * The Tasks screen then showed work that nothing was doing and no timer would
 * ever finish. That is worse than showing a failure — it is a claim that never
 * resolves, and the only way to learn the truth was to notice that a "running"
 * task had been running since last Tuesday.
 *
 * Two defences, and this covers both: shutdown cancels in-flight tasks and
 * waits for them to write themselves down, and the next boot closes out
 * anything the database still calls running, because no process is running it.
 */
describe('Tasks interrupted by a restart', () => {
  let dataDir: string;
  let dbPath: string;

  const config = () =>
    loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: dbPath,
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'task-interruption-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      PORT: '0',
    } as NodeJS.ProcessEnv);

  const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
    id: newId('tsk'),
    workspaceId: 'ws_1',
    userId: null,
    title: 'Rewrite the parser',
    request: 'Rewrite the parser',
    status: 'running',
    lane: null,
    mode: 'AUTO',
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    error: null,
    estimate: null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    result: null,
    ...overrides,
  });

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-interrupt-'));
    dbPath = join(dataDir, 'interrupt.db');
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('closes out tasks a previous process left running, queued or waiting', async () => {
    const first = await App.create(config());
    await first.start();
    const running = task({ status: 'running' });
    const queued = task({ status: 'queued', startedAt: null });
    const waiting = task({ status: 'awaiting-input' });
    const done = task({ status: 'completed', finishedAt: 99, result: 'all good' });
    for (const t of [running, queued, waiting, done]) first.store.saveTask(t);
    await first.stop();

    // A new process over the same database — a restart, as far as anything here
    // can tell.
    const second = await App.create(config());
    await second.start();
    try {
      for (const id of [running.id, queued.id, waiting.id]) {
        const reloaded = second.store.getTask(id);
        assert.equal(reloaded?.status, 'failed', `${id} must not still claim to be running after a restart`);
        assert.ok(reloaded?.finishedAt, 'and it must have an ending');
        assert.match(
          reloaded?.error ?? '',
          /stopped while this task was running/,
          `the reason must say what happened, got: ${reloaded?.error}`,
        );
      }

      // And the ones that genuinely finished are left exactly as they were.
      const untouched = second.store.getTask(done.id);
      assert.equal(untouched?.status, 'completed', 'a completed task is not an interrupted one');
      assert.equal(untouched?.finishedAt, 99, 'and its record must not be rewritten');
      assert.equal(untouched?.result, 'all good');
    } finally {
      await second.stop();
    }
  });

  it('leaves no step of an interrupted task still waiting its turn', async () => {
    const app = await App.create(config());
    await app.start();
    const stranded = task({ status: 'running' });
    app.store.saveTask(stranded);
    const step = (id: string, status: 'running' | 'pending' | 'completed', order: number): TaskStep => ({
      id,
      taskId: stranded.id,
      label: id,
      role: 'implementer',
      status,
      startedAt: status === 'pending' ? null : 1,
      finishedAt: status === 'completed' ? 2 : null,
      summary: null,
      modelId: null,
      providerId: null,
      latencyMs: null,
      usage: null,
      toolCallCount: 0,
      filesTouched: [],
      error: null,
      fallbackEvents: [],
      order,
    });
    app.store.saveStep(step('stp_done', 'completed', 0));
    app.store.saveStep(step('stp_running', 'running', 1));
    app.store.saveStep(step('stp_waiting', 'pending', 2));
    await app.stop();

    const next = await App.create(config());
    await next.start();
    try {
      const steps = Object.fromEntries(next.store.listSteps(stranded.id).map((st) => [st.id, st]));
      assert.equal(steps.stp_running?.status, 'failed', 'the step that was mid-flight failed with its task');
      // The one that was still queued. A failed task above a step marked
      // pending reads as work about to resume, and nothing will ever pick it
      // up. 'skipped', not 'failed': it was never attempted, and calling it a
      // failure would blame a model that never saw it.
      assert.equal(steps.stp_waiting?.status, 'skipped', 'a step that never started must not be left waiting forever');
      assert.ok(steps.stp_waiting?.finishedAt, 'and it must have an ending like everything else');
      assert.equal(steps.stp_done?.status, 'completed', 'and a step that finished is left exactly as it was');
      assert.equal(steps.stp_done?.finishedAt, 2);
    } finally {
      await next.stop();
    }
  });

  it('does not re-close a task on a second boot', async () => {
    const third = await App.create(config());
    await third.start();
    try {
      // Everything was reconciled last time; nothing is running now, so nothing
      // should change. A reconciliation that fired on every boot would keep
      // rewriting finishedAt on tasks that ended weeks ago.
      const again = third.store.reconcileInterruptedTasks({ instanceId: third.instanceId });
      assert.equal(again.length, 0, 'a second boot has nothing left to close out');
    } finally {
      await third.stop();
    }
  });

  it('leaves a task another live gateway is running alone', async () => {
    // Two gateways may share one database on purpose — a Compose file with two
    // replicas, a desktop app opened twice, a restart overlapping its
    // predecessor; the migration runner takes an IMMEDIATE lock precisely so
    // they can. An unqualified boot reconciliation is destructive against that:
    // the second gateway to start marks the first one's in-flight work failed,
    // broadcasts it to that gateway's clients, and the task keeps running and
    // spending anyway.
    const live = await App.create(config());
    await live.start();
    try {
      const mine = task({ status: 'running' });
      live.store.saveTask(mine);
      // The lease the running gateway holds, exactly as persistTask sets it.
      live.store.claimTask(mine.id, live.instanceId);

      // A second gateway boots against the same database.
      const other = await App.create(config());
      await other.start();
      try {
        const after = other.store.getTask(mine.id);
        assert.equal(after?.status, 'running', 'a task with a live lease must survive another gateway booting');
        assert.equal(after?.error, null, 'and must not be given a failure reason');
      } finally {
        await other.stop();
      }

      // Once that gateway is gone and its lease goes stale, the row IS the
      // stranded case — otherwise the lease would just be a way to leak rows
      // that claim to be running forever.
      const stale = Date.now() + 10 * 60_000;
      const closed = live.store.reconcileInterruptedTasks({ instanceId: 'inst_someone_else', at: stale });
      assert.equal(closed.length, 1, 'a lease nobody has refreshed for ten minutes is not a live one');
      assert.equal(live.store.getTask(mine.id)?.status, 'failed');
    } finally {
      await live.stop();
    }
  });

  it('cancels and waits for in-flight tasks on shutdown', async () => {
    // A provider that answers after thirty seconds. The task is therefore
    // genuinely in flight when shutdown begins — parked on a provider call,
    // which is where a real task spends nearly all of its life.
    const slow = await startMockProvider('slow-provider', { latencyMs: 30_000 });
    const app = await App.create(config());
    await app.start();
    app.providers.registerProvider(slow.descriptor);
    app.providers.setCredentialed('slow-provider', true);
    app.models.upsert({
      id: 'slow-provider:slow',
      providerId: 'slow-provider',
      providerModelId: 'slow',
      displayName: 'slow',
      family: null,
      modalities: ['text'],
      capabilities: ['text', 'tools'],
      contextLength: 32_768,
      maxOutputTokens: 4096,
      pricing: { kind: 'FREE', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null },
      discovered: false,
      deprecated: false,
      tags: [],
      updatedAt: Date.now(),
    });

    const root = mkdtempSync(join(tmpdir(), 'meridian-interrupt-ws-'));
    const record = app.store.createWorkspace({
      id: 'ws_slow',
      name: 'slow',
      path: root,
      repoUrl: null,
      branch: null,
      privacyMode: 'ANY_PROVIDER',
      defaultMode: 'AUTO',
      createdAt: Date.now(),
      lastOpenedAt: null,
      userId: null,
    });
    const ws = app.workspaceFor(record.id);
    assert.ok(ws, 'the workspace must open');

    const running = newTask({ workspaceId: record.id, userId: null, request: 'Take a long time' });
    app.store.saveTask(running);
    // Detached, exactly as the route starts one.
    const detached = app.orchestrator.run({ task: running, workspace: ws, mode: 'AUTO' }).catch(() => undefined);

    // Give it a moment to actually be in flight before stopping.
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 250);
      t.unref?.();
    });
    assert.deepEqual(app.orchestrator.runningTaskIds(), [running.id], 'the task must be registered as running');

    // The lease is set by the ordinary run path, not by the test. Another
    // gateway booting right now must find this task leased and leave it be —
    // which is only true if persisting a 'running' task also claims it.
    const intruder = app.store.reconcileInterruptedTasks({ instanceId: 'inst_a_second_gateway' });
    assert.equal(
      intruder.length,
      0,
      'a task that just started must carry a live lease, or another gateway will fail it mid-run',
    );
    assert.equal(app.store.getTask(running.id)?.status, 'running', 'and the row must be untouched');

    const stoppedAt = Date.now();
    await app.stop();
    const elapsed = Date.now() - stoppedAt;
    await detached;

    assert.ok(
      elapsed < 5_000,
      `shutdown must cancel the task rather than wait out its 30s provider call, took ${elapsed}ms`,
    );
    assert.equal(app.orchestrator.runningTaskIds().length, 0, 'nothing may still be registered as running');

    // The record it left behind is a finished one, written before the database
    // closed. Not "running", which is what abandoning it produced.
    const fourth = await App.create(config());
    await fourth.start();
    try {
      const finished = fourth.store.getTask(running.id);
      assert.ok(finished, 'the task record must exist');
      assert.notEqual(finished?.status, 'running', 'an abandoned task is exactly what this is about');
      assert.ok(
        finished?.status === 'cancelled' || finished?.status === 'failed',
        `expected a finished status, got ${finished?.status}`,
      );
      assert.ok(finished?.finishedAt, 'and an ending');
    } finally {
      await fourth.stop();
      await slow.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
