import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startMockProvider, type MockProvider } from '../helpers/mock-provider.js';

/**
 * End-to-end coverage of the real gateway.
 *
 * The mock provider is registered the same way a real local model server would
 * be: it is exposed on a port, the gateway's local-endpoint discovery probes it,
 * finds a model listing, and registers it. Nothing is injected past the public
 * path, so what these tests exercise is the code an operator actually runs.
 */
describe('Gateway integration', () => {
  let app: App;
  let server: FastifyInstance;
  let mock: MockProvider;
  let dataDir: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-int-'));
    mock = await startMockProvider('local-probe', { models: ['test-model', 'test-embed'], reply: 'hello from the gateway' });
    const mockRoot = mock.baseUrl.replace(/\/v1$/, '');

    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'test.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'integration-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: mockRoot,
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.ready();
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await mock?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /* ---------------- Discovery ---------------- */

  it('discovers the local endpoint and registers its models', () => {
    const models = app.models.all();
    assert.ok(models.length >= 2, `expected the probe to register models, saw ${models.length}`);
    const model = models.find((m) => m.providerModelId === 'test-model');
    assert.ok(model, 'the listed model should be registered');
    // A locally-served model must never be described as costing money.
    assert.equal(model.pricing.kind, 'LOCAL');
  });

  it('reports the discovered provider as local and verified', () => {
    const local = app.providers.list().find((p) => p.local && app.models.all().some((m) => m.providerId === p.id));
    assert.ok(local, 'a local provider should exist');
    assert.equal(local.trust, 'verified');
    assert.equal(local.auth, 'none');
  });

  /* ---------------- System ---------------- */

  it('serves system info on the documented port configuration', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/system/info' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { name: string; defaultPort: number; counts: { models: number } };
    assert.equal(body.name, 'Meridian');
    assert.equal(body.defaultPort, 4639);
    assert.ok(body.counts.models > 0);
  });

  it('exposes the vocabulary the client renders from', async () => {
    const body = (await server.inject({ method: 'GET', url: '/api/system/vocabulary' })).json() as {
      routingModes: { value: string; primary: boolean }[];
      agents: { role: string }[];
    };
    assert.equal(body.routingModes.length, 15);
    assert.equal(body.routingModes.filter((m) => m.primary).length, 6);
    assert.deepEqual(
      body.agents.map((a) => a.role).sort(),
      ['browser', 'debugger', 'file-finder', 'implementer', 'orchestrator', 'planner', 'researcher', 'reviewer', 'tester'],
    );
  });

  /* ---------------- OpenAI-compatible API ---------------- */

  it('lists models in the OpenAI shape', async () => {
    const body = (await server.inject({ method: 'GET', url: '/v1/models' })).json() as {
      object: string;
      data: { id: string; object: string; meridian: { free: boolean } }[];
    };
    assert.equal(body.object, 'list');
    assert.ok(body.data.length > 0);
    assert.equal(body.data[0].object, 'model');
    assert.equal(body.data[0].meridian.free, true, 'local models are free');
  });

  it('completes a chat with no model specified, choosing one itself', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
      meridian: { provider: string; model: string; routing: { summary: string; criteria: unknown[] } };
    };
    assert.equal(body.choices[0].message.content, 'hello from the gateway');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.total_tokens > 0);
    // Routing transparency travels with every response.
    assert.ok(body.meridian.routing.summary.length > 10);
    assert.ok(body.meridian.routing.criteria.length >= 4);
  });

  it('honours a pinned model', async () => {
    const modelId = app.models.all().find((m) => m.providerModelId === 'test-model')!.id;
    const body = (
      await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: modelId, messages: [{ role: 'user', content: 'hi' }] },
      })
    ).json() as { meridian: { model: string } };
    assert.equal(body.meridian.model, 'test-model');
  });

  it('streams a chat completion as server-sent events', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);

    const frames = res.body
      .split('\n\n')
      .map((f) => f.replace(/^data: /, '').trim())
      .filter((f) => f && f !== '[DONE]')
      .map((f) => JSON.parse(f) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] });

    const text = frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join('');
    assert.match(text, /hello from the gateway/);
    assert.ok(res.body.endsWith('data: [DONE]\n\n'), 'the stream must terminate with the DONE sentinel');
  });

  it('returns a structured error, not a stack trace, for an unknown model', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'nope:does-not-exist', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'model_unavailable');
    assert.equal(body.error.message.includes('at '), false, 'no stack frames in a client-facing error');
  });

  it('serves embeddings', async () => {
    const body = (
      await server.inject({ method: 'POST', url: '/v1/embeddings', payload: { input: ['a', 'b'] } })
    ).json() as { data: { embedding: number[] }[]; meridian: { provider: string } };
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].embedding.length, 3);
  });

  /* ---------------- Anthropic-compatible API ---------------- */

  it('completes a message in the Anthropic shape', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      payload: { max_tokens: 100, system: 'be brief', messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      type: string;
      role: string;
      content: { type: string; text: string }[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, 'hello from the gateway');
    assert.equal(body.stop_reason, 'end_turn');
    assert.ok(body.usage.input_tokens > 0);
  });

  it('streams Anthropic messages as typed events', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      payload: { max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.statusCode, 200);
    // The Anthropic dialect requires named events, not bare data frames.
    for (const name of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      assert.ok(res.body.includes(`event: ${name}`), `missing ${name} event`);
    }
  });

  it('counts tokens and says the count is an estimate', async () => {
    const body = (
      await server.inject({
        method: 'POST',
        url: '/anthropic/v1/messages/count_tokens',
        payload: { messages: [{ role: 'user', content: 'hello world' }] },
      })
    ).json() as { input_tokens: number; meridian: { estimated: boolean } };
    assert.ok(body.input_tokens > 0);
    assert.equal(body.meridian.estimated, true);
  });

  /* ---------------- Admin ---------------- */

  it('never returns a credential secret through the API', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { providerId: 'groq', secret: 'gsk_THISMUSTNEVERAPPEARINARESPONSE1234', label: 'test key' },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.includes('THISMUSTNEVERAPPEAR'), false, 'the create response leaked the secret');

    const listed = await server.inject({ method: 'GET', url: '/api/credentials' });
    assert.equal(listed.body.includes('THISMUSTNEVERAPPEAR'), false, 'the list response leaked the secret');
    const body = listed.json() as { credentials: { hint: string; label: string }[] };
    const record = body.credentials.find((c) => c.label === 'test key');
    assert.ok(record, 'the credential should exist');
    assert.match(record.hint, /^••••/);
  });

  it('keeps secrets out of the audit log', async () => {
    const body = (await server.inject({ method: 'GET', url: '/api/system/audit' })).json() as { entries: unknown[] };
    assert.equal(JSON.stringify(body).includes('THISMUSTNEVERAPPEAR'), false);
  });

  it('previews routing without executing anything', async () => {
    const before = mock.calls.length;
    const body = (
      await server.inject({ method: 'POST', url: '/api/routing/preview', payload: { modality: 'text', taskType: 'chat' } })
    ).json() as { decision: { provider: string } | null; candidates: unknown[] };
    assert.ok(body.decision, 'a decision should be produced');
    assert.ok(body.candidates.length > 0);
    assert.equal(mock.calls.length, before, 'a preview must not call the provider');
  });

  it('lists pools with their live usage and limits', async () => {
    const body = (await server.inject({ method: 'GET', url: '/api/pools' })).json() as {
      pools: { id: string; usage: { spentToday: number }; budgetLimit: number | null }[];
    };
    assert.ok(body.pools.length >= 11);
    const free = body.pools.find((p) => p.id === 'core');
    assert.ok(free);
    assert.equal(free.budgetLimit, 0, 'the Core pool is a no-spend pool');
  });

  it('creates and cancels a reservation', async () => {
    const created = (
      await server.inject({ method: 'POST', url: '/api/reservations', payload: { poolId: 'core', hours: 2, maxConcurrency: 12 } })
    ).json() as { reservation: { id: string; status: string; maxConcurrency: number } };
    assert.equal(created.reservation.status, 'active');
    assert.equal(app.pools.concurrencyLimit('core'), 12, 'an active reservation raises the ceiling');

    const removed = (await server.inject({ method: 'DELETE', url: `/api/reservations/${created.reservation.id}` })).json() as { removed: boolean };
    assert.equal(removed.removed, true);
  });

  /* ---------------- Workspaces ---------------- */

  it('creates a workspace, writes a file, and reverts the change exactly', async () => {
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'integration' } })
    ).json() as { workspace: { id: string } };

    await server.inject({ method: 'PUT', url: `/api/workspaces/${workspace.id}/file`, payload: { path: 'a.txt', content: 'first' } });
    const read = (await server.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/file?path=a.txt` })).json() as { content: string };
    assert.equal(read.content, 'first');

    const changes = (await server.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/changes` })).json() as {
      changes: { path: string; kind: string }[];
      diff: string;
    };
    assert.equal(changes.changes[0].kind, 'added');
    assert.match(changes.diff, /\+first/);

    await server.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/changes`, payload: { action: 'reject' } });
    const after = await server.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/file?path=a.txt` });
    assert.equal(after.statusCode, 400, 'rejecting a created file must remove it');
  });

  it('refuses a path that escapes the workspace', async () => {
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'escape' } })
    ).json() as { workspace: { id: string } };

    const res = await server.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/file?path=${encodeURIComponent('../../../etc/passwd')}` });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: { message: string } }).error.message, /outside the workspace/);
  });

  it('runs a sandboxed command and reports its isolation honestly', async () => {
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'exec' } })
    ).json() as { workspace: { id: string } };

    const body = (
      await server.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/exec`, payload: { command: 'echo meridian-ok' } })
    ).json() as { stdout: string; exitCode: number; sandbox: { kind: string; isolation: string } };
    assert.match(body.stdout, /meridian-ok/);
    assert.equal(body.exitCode, 0);
    assert.equal(body.sandbox.kind, 'process');
    assert.match(body.sandbox.isolation, /not a security boundary/i);
  });

  it('does not leak the gateway environment into a sandboxed command', async () => {
    process.env.MERIDIAN_TEST_LEAK_CANARY = 'canary-must-not-leak';
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'env' } })
    ).json() as { workspace: { id: string } };

    const body = (
      await server.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/exec`, payload: { command: 'env' } })
    ).json() as { stdout: string };
    assert.equal(body.stdout.includes('canary-must-not-leak'), false, 'the sandbox must build its environment from scratch');
    delete process.env.MERIDIAN_TEST_LEAK_CANARY;
  });

  it('estimates a task before running it', async () => {
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'estimate' } })
    ).json() as { workspace: { id: string } };

    const body = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks/estimate',
        payload: { workspaceId: workspace.id, request: 'add retry logic to the http client' },
      })
    ).json() as { estimate: { calls: number; cost: number; freeAvailable: boolean }; pipeline: { steps: string[]; rationale: string } };

    assert.ok(body.estimate.calls > 0);
    assert.equal(body.estimate.cost, 0, 'a local-only instance costs nothing');
    assert.equal(body.estimate.freeAvailable, true);
    assert.deepEqual(body.pipeline.steps, ['file-finder', 'planner', 'implementer', 'tester', 'reviewer']);
    assert.ok(body.pipeline.rationale.length > 20);
  });

  it('chooses a shorter pipeline for a question', async () => {
    const { workspace } = (
      await server.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'question' } })
    ).json() as { workspace: { id: string } };

    const body = (
      await server.inject({
        method: 'POST',
        url: '/api/tasks/estimate',
        payload: { workspaceId: workspace.id, request: 'where is the retry logic defined?' },
      })
    ).json() as { pipeline: { steps: string[] } };
    assert.deepEqual(body.pipeline.steps, ['file-finder', 'researcher']);
  });

  /* ---------------- Usage ---------------- */

  it('records usage for every call it served', async () => {
    const body = (await server.inject({ method: 'GET', url: '/api/usage?days=1' })).json() as {
      summary: { totals: { requests: number; cost: number }; byModel: { modelId: string }[] };
    };
    assert.ok(body.summary.totals.requests > 0, 'the earlier chat calls should be recorded');
    assert.equal(body.summary.totals.cost, 0, 'local calls cost nothing');
    assert.ok(body.summary.byModel.length > 0);
  });

  /* ---------------- Security headers ---------------- */

  it('sets security headers and a request id on every response', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/system/health' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'] as string, /default-src 'self'/);
    assert.match(res.headers['content-security-policy'] as string, /object-src 'none'/);
    assert.ok(res.headers['x-request-id']);
  });

  it('rejects an unknown API route with a structured error', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_request');
  });
});
