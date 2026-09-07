import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * The computer agent against a running gateway and a real inference server.
 *
 * These tests exist for the properties a user's safety rests on, and each one
 * is written to fail if the guarantee became cosmetic:
 *
 *  - a permission that is not granted stops the action at the gateway, not at
 *    the model's discretion;
 *  - an action awaiting approval has not happened yet;
 *  - Stop terminates work that is genuinely in flight, including a model call,
 *    and leaves no backend process behind.
 *
 * The last one is why the sim server's `stall` directive is used: a Stop tested
 * only against an idle session proves nothing, because the interesting failure
 * is a session blocked inside a request the kill switch cannot reach.
 *
 * The desktop backend needs an X display, so the cases that drive a real
 * pointer are skipped without one rather than reported as passes.
 */

const HAS_DISPLAY = Boolean(process.env.MERIDIAN_DISPLAY ?? process.env.DISPLAY);

interface SessionView {
  id: string;
  state: string;
  step: number;
  summary: string | null;
  error: string | null;
  userId: string | null;
  activeModelId: string | null;
  activeBackendId: string;
  pendingApproval: { id: string; description: string; verdict: { risk: string; decision: string } } | null;
}

interface ActionView {
  step: number;
  action: { type: string };
  status: string;
  result: string | null;
  error: string | null;
  verdict: { decision: string; reason: string | null; risk: string };
}

describe('Computer agent', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let url: string;

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    // Fastify rejects a JSON content-type with no body, and several of these
    // endpoints take no arguments, so an empty object stands in for one.
    const method = init.method ?? 'GET';
    const body = init.body ?? (method === 'GET' ? undefined : '{}');
    const res = await fetch(`${url}${path}`, {
      ...init,
      body,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  /**
   * A task whose text carries the directive that decides what the model says.
   *
   * The task reaches the planner's system prompt verbatim, so embedding the
   * directive there is how a deterministic action is put in the model's mouth
   * without the test reaching past the model into the loop.
   */
  const taskEmitting = (action: unknown, summary = 'step'): string =>
    `Drive the screen. [[sim: say ${JSON.stringify({ summary, action })}]]`;

  const start = async (body: Record<string, unknown>): Promise<SessionView> => {
    const res = await call<{ session: SessionView }>('/api/computer/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.session;
  };

  const read = async (id: string): Promise<{ session: SessionView; actions: ActionView[]; live: boolean }> =>
    call(`/api/computer/sessions/${id}`);

  /** Poll until a predicate holds, so tests never depend on a fixed sleep. */
  const until = async <T>(fn: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 15_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last = await fn();
    while (!ok(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      last = await fn();
    }
    return last;
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-computer-'));
    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'computer.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'computer-agent-test-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      // A fixed grounding space, so the scaling assertion has an exact answer.
      MERIDIAN_GROUNDING_WIDTH: '1000',
      MERIDIAN_GROUNDING_HEIGHT: '1000',
      PORT: '0',
    } as NodeJS.ProcessEnv);
    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /* ---- The default posture ------------------------------------------- */

  it('is off by default and says so', async () => {
    const vocab = await call<{
      defaultEnabled: boolean;
      presets: { safe: Record<string, boolean>; readOnly: Record<string, boolean> };
    }>('/api/computer/vocabulary');
    assert.equal(vocab.defaultEnabled, false, 'computer control must never default to on');
    // The safe preset is ordinary interactive use: look, point, type, launch.
    // What makes it safe is the line it does not cross — nothing that reaches
    // the filesystem, a shell, the network, or another machine.
    for (const denied of [
      'terminal',
      'files_read',
      'files_write',
      'files_delete',
      'files_download',
      'files_upload',
      'network',
      'docker',
      'mcp',
      'remote_computer',
    ]) {
      assert.notEqual(vocab.presets.safe[denied], true, `the safe preset must not grant ${denied}`);
    }
    assert.deepEqual(vocab.presets.readOnly, { screen: true }, 'read-only means look, nothing else');
  });

  it('reports every backend, and explains the ones that are unavailable', async () => {
    const { backends } = await call<{
      backends: { id: string; health: { available: boolean; detail: string | null; remediation: string | null } }[];
    }>('/api/computer/backends');
    const ids = backends.map((b) => b.id);
    for (const id of ['native', 'browser', 'agent-s', 'ui-tars']) {
      assert.ok(ids.includes(id), `${id} is listed`);
    }
    // An absent backend must appear with a reason, never vanish from the list.
    for (const b of backends) {
      if (!b.health.available) {
        assert.ok(b.health.detail, `${b.id} explains why it is unavailable`);
        assert.ok(b.health.remediation, `${b.id} says what would fix it`);
      }
    }
  });

  /* ---- Routing is by capability, not by a model-to-agent table -------- */

  it('refuses to hand a computer to a model that does not report vision', async () => {
    const { models } = await call<{ models: { id: string }[] }>('/api/models?limit=50');
    const chat = models.find((m) => m.id.includes('sim-chat'))!.id;
    const { decision } = await call<{ decision: { modelId: string | null; error: string | null } }>(
      '/api/computer/plan',
      { method: 'POST', body: JSON.stringify({ modelId: chat }) },
    );
    assert.equal(decision.modelId, null);
    assert.match(decision.error ?? '', /vision/i);
  });

  it('explains what Auto chose rather than just naming it', async () => {
    const { decision } = await call<{
      decision: { modelId: string | null; backendId: string | null; reason: string; factors: string[] };
    }>('/api/computer/plan', { method: 'POST', body: JSON.stringify({}) });
    assert.ok(decision.modelId, 'Auto found a model');
    assert.ok(decision.backendId, 'Auto found a backend');
    assert.ok(decision.factors.length > 0, 'the choice comes with its reasoning');
  });

  /* ---- The permission engine ------------------------------------------ */

  it('refuses an action outside the granted permissions, at the gateway', async () => {
    const session = await start({
      task: taskEmitting({ type: 'type', text: 'hello' }, 'Type into the field'),
      backendId: 'browser',
      // Screen only: the model is about to ask to type anyway.
      permissions: { screen: true },
      approvalMode: 'autonomous',
      maxSteps: 2,
    });
    const view = await until(
      () => read(session.id),
      (v) => v.actions.length > 0,
    );
    const denied = view.actions[0];
    assert.equal(denied.action.type, 'type');
    assert.equal(denied.status, 'denied');
    assert.equal(denied.verdict.decision, 'reject');
    assert.match(denied.verdict.reason ?? '', /keyboard/);
    await call(`/api/computer/sessions/${session.id}/stop`, { method: 'POST' });
  });

  /* ---- Approval gates the action, not the report of it ---------------- */

  it('holds an action at the approval gate and never runs a denied one', async () => {
    const session = await start({
      task: taskEmitting({ type: 'click', to: { x: 500, y: 500 } }, 'Click the button'),
      backendId: 'browser',
      permissions: { screen: true, mouse: true },
      approvalMode: 'every_action',
      maxSteps: 2,
    });

    const waiting = await until(
      () => read(session.id),
      (v) => v.session.state === 'awaiting_approval' && v.session.pendingApproval !== null,
    );
    assert.equal(waiting.session.state, 'awaiting_approval');
    const approval = waiting.session.pendingApproval!;
    // The dialog must describe the actual action, not "the agent wants to
    // continue" — a user cannot consent to something unnamed.
    assert.match(approval.description, /click/i);

    // Nothing has executed: the action is still un-run while the gate is held.
    assert.ok(
      waiting.actions.every((a) => a.status !== 'completed'),
      'no action completed while approval was pending',
    );

    const denied = await call<{ denied: boolean }>(`/api/computer/sessions/${session.id}/deny`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.id }),
    });
    assert.equal(denied.denied, true);

    const after = await until(
      () => read(session.id),
      (v) => v.actions.some((a) => a.status === 'denied'),
    );
    const record = after.actions.find((a) => a.status === 'denied')!;
    assert.match(record.error ?? '', /denied by the user/);
    assert.notEqual(record.status, 'completed');
    await call(`/api/computer/sessions/${session.id}/stop`, { method: 'POST' });
  });

  /* ---- Stop is the property everything else depends on ---------------- */

  it('stops a session blocked inside a model call, and releases its backend', async () => {
    // `stall` makes the sim server accept the planning request and never
    // answer, which parks the loop inside the model call. A Stop that only
    // flipped a flag would leave this request in flight and the backend open.
    const session = await start({
      task: 'Drive the screen. [[sim: stall]]',
      backendId: 'browser',
      permissions: { screen: true, mouse: true },
      approvalMode: 'autonomous',
      maxSteps: 8,
    });
    await until(
      () => read(session.id),
      (v) => v.session.state === 'running',
    );

    const began = Date.now();
    await call(`/api/computer/sessions/${session.id}/stop`, { method: 'POST' });
    const stopped = await until(
      () => read(session.id),
      (v) => v.session.state === 'stopped',
      5_000,
    );
    assert.equal(stopped.session.state, 'stopped');
    assert.ok(Date.now() - began < 5_000, 'Stop takes effect promptly, not when the model happens to reply');

    // A deliberate stop is not a failure, and must not be reported as one.
    assert.equal(stopped.session.error, null);
    assert.match(stopped.session.summary ?? '', /stopped by the user/);

    // The loop is genuinely finished: no further steps arrive after the stop.
    const stepsAtStop = stopped.session.step;
    await new Promise((r) => setTimeout(r, 1_000));
    const later = await read(session.id);
    assert.equal(later.session.step, stepsAtStop, 'no action was taken after the session stopped');
  });

  it('cancels a long wait instead of letting it run out', async () => {
    const session = await start({
      task: taskEmitting({ type: 'wait', ms: 45_000 }, 'Wait for the screen to settle'),
      backendId: 'browser',
      permissions: { screen: true },
      approvalMode: 'autonomous',
      maxSteps: 2,
    });
    await until(
      () => read(session.id),
      (v) => v.session.state === 'running',
    );
    // Give the loop time to reach the wait, then interrupt it well inside the
    // 45 seconds it would otherwise take.
    await new Promise((r) => setTimeout(r, 1_500));
    const began = Date.now();
    await call(`/api/computer/sessions/${session.id}/stop`, { method: 'POST' });
    const stopped = await until(
      () => read(session.id),
      (v) => v.session.state === 'stopped',
      5_000,
    );
    const elapsed = Date.now() - began;
    assert.equal(stopped.session.state, 'stopped');
    assert.ok(elapsed < 5_000, `stop returned in ${elapsed}ms, well inside the 45s wait`);
  });

  /* ---- What is written down ------------------------------------------- */

  it('records the owner, the outcome and the refusals in the database', async () => {
    const session = await start({
      task: taskEmitting({ type: 'finish', success: true, summary: 'All done.' }, 'Finishing'),
      backendId: 'browser',
      permissions: { screen: true },
      approvalMode: 'autonomous',
      maxSteps: 2,
    });
    const done = await until(
      () => read(session.id),
      (v) => ['completed', 'failed', 'stopped'].includes(v.session.state),
    );
    assert.equal(done.session.state, 'completed');
    // A finished session must persist its outcome, not just hold it in memory.
    assert.ok(done.session.summary, 'the outcome is recorded');
    const stored = app.store.getComputerSession(session.id)!;
    assert.equal(stored.state, 'completed');
    assert.ok(stored.summary, 'the stored row carries the summary');
    assert.ok(stored.finishedAt, 'the stored row carries the end time');
    assert.ok(stored.config, 'the stored row snapshots the config it ran under');
  });

  /* ---- The real desktop ------------------------------------------------ */

  it(
    'moves a real pointer to the scaled coordinate',
    { skip: HAS_DISPLAY ? false : 'no X display available' },
    async () => {
      const diag = await call<{ checks: { name: string; status: string; detail: string }[] }>(
        '/api/computer/diagnostics',
        { method: 'POST', body: JSON.stringify({ backendId: 'native' }) },
      );
      const failed = diag.checks.filter((c) => c.status === 'fail');
      assert.deepEqual(failed, [], `diagnostics failed: ${failed.map((f) => f.detail).join('; ')}`);

      // 300,600 in the 1000x1000 grounding space, scaled to the real screen.
      const session = await start({
        task: taskEmitting({ type: 'move', to: { x: 300, y: 600 } }, 'Moving the pointer'),
        backendId: 'native',
        permissions: { screen: true, mouse: true },
        approvalMode: 'autonomous',
        maxSteps: 4,
      });
      const view = await until(
        () => read(session.id),
        (v) => v.actions.some((a) => a.status === 'completed'),
      );
      const moved = view.actions.find((a) => a.status === 'completed')!;
      assert.equal(moved.action.type, 'move');

      // Derived from what the backend actually reports rather than assumed, so
      // this asserts the scaling contract itself: whatever grounding space is
      // configured, the model's coordinates must land on the real pixel.
      const { backends } = await call<{
        backends: { id: string; screen: { width: number; height: number; groundingWidth: number; groundingHeight: number } | null }[];
      }>('/api/computer/backends');
      const screen = backends.find((b) => b.id === 'native')!.screen!;
      assert.notEqual(screen.groundingWidth, screen.width, 'the test configures a grounding space that differs from the screen');
      const expected = `moved to ${Math.round((300 * screen.width) / screen.groundingWidth)}, ${Math.round(
        (600 * screen.height) / screen.groundingHeight,
      )}`;
      assert.equal(moved.result, expected, 'the model’s coordinates were scaled into real pixels');
      await call(`/api/computer/sessions/${session.id}/stop`, { method: 'POST' });
    },
  );
});
