import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, newId, type AgentTask } from '@meridian/shared';
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

  it('does not re-close a task on a second boot', async () => {
    const third = await App.create(config());
    await third.start();
    try {
      // Everything was reconciled last time; nothing is running now, so nothing
      // should change. A reconciliation that fired on every boot would keep
      // rewriting finishedAt on tasks that ended weeks ago.
      const again = third.store.reconcileInterruptedTasks();
      assert.equal(again.length, 0, 'a second boot has nothing left to close out');
    } finally {
      await third.stop();
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
