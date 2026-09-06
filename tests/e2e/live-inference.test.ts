import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * End-to-end verification against a real inference server over a real socket.
 *
 * Everything below crosses the whole stack: an HTTP client talks to the gateway
 * on a listening port, the gateway routes, resolves credentials and opens its
 * own HTTP connection to a separate inference process, and the bytes come back
 * through Meridian's streaming, tool-call assembly and usage accounting.
 *
 * What this proves is that Meridian works. It says nothing about model quality:
 * the inference server is deterministic and rule-based by design (see
 * scripts/local-model-server.mjs), so a passing test here is evidence about the
 * gateway, never about a model.
 */
describe('E2E: gateway against a real local inference server', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let failing: SimServer;
  let dataDir: string;
  let base: string;

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => (await api(path, init)).json() as Promise<T>;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-e2e-'));
    sim = await startSimServer();
    // A second server that is up, reachable and refuses every completion. This
    // is the shape a fallback chain has to survive.
    failing = await startSimServer(['--fail-with', 'rate_limited']);

    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'e2e.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'e2e-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: `${sim.root},${failing.root}`,
      // Short enough that a stalled stream is observable in a test, long enough
      // that a healthy local server never trips it.
      MERIDIAN_STREAM_IDLE_TIMEOUT_MS: '1500',
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    await failing?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const simProviderId = (): string => {
    const provider = app.providers.list().find((p) => p.local && p.baseUrl.includes(`:${sim.port}`));
    assert.ok(provider, 'the healthy inference server should be registered as a provider');
    return provider.id;
  };

  /* ---------------- Discovery ---------------- */

  it('discovers both inference servers and registers their models', () => {
    const models = app.models.all();
    const mine = models.filter((m) => m.providerModelId.startsWith('meridian-sim'));
    assert.ok(mine.length >= 3, `expected the sim models to be registered, saw ${mine.length}`);

    const chat = mine.find((m) => m.providerModelId === 'meridian-sim-chat');
    assert.ok(chat);
    // A model served from the operator's own machine must never be described as
    // costing money, and must carry the context length the listing reported.
    assert.equal(chat.pricing.kind, 'LOCAL');
    assert.equal(chat.contextLength, 32_768);
    assert.ok(chat.capabilities.includes('tools'), 'a local OpenAI server serves tool calls');
  });

  /* ---------------- OpenAI surface ---------------- */

  it('completes a chat through the OpenAI surface and reports real usage', async () => {
    const body = await json<{
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number };
      meridian: { provider: string; attempts: number };
    }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping from the e2e suite' }] }),
    });

    assert.equal(body.choices[0].message.content, 'meridian-sim: ping from the e2e suite');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.prompt_tokens > 0 && body.usage.completion_tokens > 0, 'usage must come from the provider');
    assert.equal(body.meridian.attempts, 1);
  });

  it('streams a chat completion in more than one chunk', async () => {
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'one two three four' }] }),
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    // A streamed response writes to the raw socket, which bypasses Fastify's
    // header handling. It must still carry what a buffered response carries.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('content-security-policy'), 'the CSP must survive the switch to raw streaming');
    assert.ok(res.headers.get('x-request-id'), 'a streamed response must still be traceable');
    const text = await res.text();
    const deltas = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    assert.ok(deltas.length >= 3, `expected the stream to arrive in pieces, saw ${deltas.length}`);
    assert.ok(deltas.join('').includes('one two three four'));
    assert.ok(text.trimEnd().endsWith('data: [DONE]'), 'the stream must terminate with the DONE sentinel');
  });

  it('reassembles a tool call whose arguments arrive as JSON fragments', async () => {
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: '[[sim: call read_file {"path":"deep/nested/file.ts","offset":40}]]' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
      }),
    });
    const text = await res.text();
    const frames = text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)) as { choices?: { delta?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] });

    let name = '';
    let args = '';
    for (const frame of frames) {
      for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
        name += call.function?.name ?? '';
        args += call.function?.arguments ?? '';
      }
    }
    assert.equal(name, 'read_file');
    // The fragments split mid-JSON on purpose: this only parses if the gateway
    // accumulated them rather than parsing each fragment.
    assert.deepEqual(JSON.parse(args), { path: 'deep/nested/file.ts', offset: 40 });
  });

  /* ---------------- Anthropic surface ---------------- */

  it('serves the Anthropic Messages contract, including tool use', async () => {
    const text = await json<{ content: { type: string; text?: string }[]; stop_reason: string }>('/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', max_tokens: 128, messages: [{ role: 'user', content: 'hello anthropic' }] }),
    });
    assert.equal(text.content[0].type, 'text');
    assert.equal(text.stop_reason, 'end_turn');

    const tool = await json<{ content: { type: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string }>(
      '/anthropic/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'auto',
          max_tokens: 128,
          messages: [{ role: 'user', content: '[[sim: call get_weather {"city":"Lisbon"}]]' }],
          tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: {} } }],
        }),
      },
    );
    assert.equal(tool.stop_reason, 'tool_use');
    assert.equal(tool.content[0].type, 'tool_use');
    assert.equal(tool.content[0].name, 'get_weather');
    assert.deepEqual(tool.content[0].input, { city: 'Lisbon' });
  });

  it('streams Anthropic events in the documented order', async () => {
    const res = await api('/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', max_tokens: 128, stream: true, messages: [{ role: 'user', content: 'alpha beta gamma' }] }),
    });
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.equal(events[0], 'message_start');
    assert.ok(events.includes('content_block_start'));
    assert.ok(events.filter((e) => e === 'content_block_delta').length >= 2);
    assert.equal(events.at(-1), 'message_stop');
  });

  it('serves embeddings through the gateway, deterministically and at the requested width', async () => {
    const body = await json<{ data: { embedding: number[]; index: number }[]; model: string }>('/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', input: ['alpha', 'beta', 'alpha'] }),
    });

    assert.equal(body.data.length, 3);
    const width = body.data[0].embedding.length;
    assert.ok(width >= 64, `expected a real vector width, saw ${width}`);
    assert.ok(
      body.data.every((d) => d.embedding.length === width),
      'every vector in a batch must have the same width',
    );
    // Same input, same vector — a gateway that shuffled or truncated a batch
    // would break this even though each individual call looked fine.
    assert.deepEqual(body.data[0].embedding, body.data[2].embedding);
    assert.notDeepEqual(body.data[0].embedding, body.data[1].embedding);
  });

  it('lists the discovered models on the OpenAI models route', async () => {
    const body = await json<{ data: { id: string; owned_by?: string }[] }>('/v1/models');
    const ids = body.data.map((m) => m.id);
    assert.ok(
      ids.some((id) => id.endsWith('meridian-sim-chat')),
      `the discovered chat model should be listed, saw ${ids.slice(0, 5).join(', ')}`,
    );
  });

  it('honours routing modes and explains a mode it cannot satisfy', async () => {
    for (const mode of ['FREE', 'LOCAL', 'FAST', 'CHEAP']) {
      const body = await json<{ meridian: { provider: string; routing: { mode: string; requestedMode: string } } }>('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: `mode ${mode}` }],
          meridian: { mode },
        }),
      });
      // The plain-language modes are aliases for explicit policies, so the
      // explanation has to name both: what was asked for, and what ran.
      assert.equal(body.meridian.routing.requestedMode, mode, 'the decision must echo the mode that was requested');
      assert.ok(body.meridian.routing.mode, 'the decision must name the policy it actually scored under');
      assert.equal(body.meridian.provider, simProviderId(), `${mode} should reach the local server`);
    }

    // Pinning a provider that has no credential here must fail with a reason,
    // not quietly route somewhere else and let the caller believe otherwise.
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'reach a provider that is not configured' }],
        meridian: { provider: 'openai' },
      }),
    });
    assert.ok(res.status >= 400, `an unsatisfiable routing request must not return 200, got ${res.status}`);
    const failure = (await res.json()) as { error?: { message: string } };
    assert.ok(failure.error?.message, 'the failure must carry an explanation');
    assert.match(failure.error.message, /openai/i, 'the explanation must name what could not be satisfied');
  });

  /* ---------------- Fallback ---------------- */

  it('fails over to a healthy provider when the preferred one refuses', async () => {
    const broken = app.providers.list().find((p) => p.local && p.baseUrl.includes(`:${failing.port}`));
    assert.ok(broken, 'the refusing inference server should still be registered — it is up, it just says no');

    // Preferring the broken provider makes it win routing, so the request has to
    // fail over to succeed. Without this the tie between two identical local
    // servers would decide the test.
    await api('/api/preferences', { method: 'PUT', body: JSON.stringify({ preferredProviders: [broken.id] }) });
    try {
      const body = await json<{
        choices: { message: { content: string } }[];
        meridian: { provider: string; attempts: number; fallbacks: { reason: string }[] };
      }>('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'survive the refusal' }] }),
      });

      assert.equal(body.meridian.provider, simProviderId(), 'the answer must come from the healthy server');
      assert.ok(body.meridian.attempts >= 2, `expected a retry, saw ${body.meridian.attempts} attempt(s)`);
      assert.ok(body.meridian.fallbacks.length >= 1, 'the fallback must be recorded, not silent');
      assert.equal(body.choices[0].message.content, 'meridian-sim: survive the refusal');
    } finally {
      await api('/api/preferences', { method: 'PUT', body: JSON.stringify({ preferredProviders: [] }) });
    }
  });

  it('abandons a stream that goes silent instead of hanging on it', async () => {
    const started = Date.now();
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: '[[sim: stall]]' }] }),
    });
    // The provider opened a stream and then sent nothing. The gateway must give
    // up on its own; the client is not the thing that ends this.
    const text = await res.text();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `the gateway should have abandoned the stall quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= 1_000, `it must not give up before the configured idle window, took ${elapsed}ms`);
    assert.match(text, /stall|timeout|timed out/i, `the failure must say the stream stalled, got: ${text.slice(0, 300)}`);
  });

  /* ---------------- Readiness and onboarding ---------------- */

  it('reports readiness separately from liveness', async () => {
    const live = await api('/api/system/health');
    assert.equal(live.status, 200);

    const res = await api('/api/system/ready');
    const body = (await res.json()) as { ready: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    assert.equal(res.status, 200, `a gateway with models available must be ready: ${JSON.stringify(body.checks)}`);
    assert.equal(body.ready, true);
    const names = body.checks.map((c) => c.name);
    for (const expected of ['database', 'discovery', 'models']) {
      assert.ok(names.includes(expected), `readiness should check ${expected}, saw ${names.join(', ')}`);
    }
    assert.ok(
      body.checks.every((c) => c.detail.length > 0),
      'every check must say what it found, not just pass or fail',
    );
  });

  it('describes what a fresh install still needs', async () => {
    const body = await json<{ complete: boolean; steps: { id: string; done: boolean; detail: string }[] }>('/api/onboarding');
    const inference = body.steps.find((s) => s.id === 'inference');
    assert.ok(inference, 'onboarding must cover connecting somewhere to run models');
    assert.equal(inference.done, true, 'an instance with a discovered local server has inference covered');
    assert.match(inference.detail, /model/i);
    const sandbox = body.steps.find((s) => s.id === 'sandbox');
    assert.ok(sandbox);
    // This instance runs with MERIDIAN_SANDBOX=process, which is not isolation.
    assert.equal(sandbox.done, false, 'the process sandbox must not be reported as isolated');
  });

  /* ---------------- Idempotency ---------------- */

  it('replays a repeated request instead of running it twice', async () => {
    const payload = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'charge me once' }] });
    const key = 'e2e-idempotency-1';

    const first = await api('/v1/chat/completions', { method: 'POST', headers: { 'idempotency-key': key }, body: payload });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-idempotency'), 'stored');
    const firstBody = (await first.json()) as { id: string; meridian: { request_id: string } };

    const second = await api('/v1/chat/completions', { method: 'POST', headers: { 'idempotency-key': key }, body: payload });
    assert.equal(second.headers.get('x-idempotency'), 'replayed');
    const secondBody = (await second.json()) as { id: string; meridian: { request_id: string } };
    // Same response, byte for byte — including the request id, which proves the
    // second call was replayed rather than re-run.
    assert.deepEqual(secondBody, firstBody);

    // A key reused for a different body is a client bug, not a cache hit.
    const conflict = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'something else entirely' }] }),
    });
    assert.equal(conflict.status, 422);
    assert.equal(conflict.headers.get('x-idempotency'), 'conflict');

    // A streamed response cannot be stored and handed back, and the header says
    // so rather than pretending the key was honoured.
    const streamed = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'idempotency-key': 'e2e-idempotency-stream' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'stream' }] }),
    });
    assert.equal(streamed.headers.get('x-idempotency'), 'not-applied-to-streaming');
    await streamed.text();
  });

  /* ---------------- Cancellation ---------------- */

  it('stops streaming when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'a b c d e f g h' }] }),
    });
    const reader = res.body?.getReader();
    assert.ok(reader);
    await reader.read();
    controller.abort();

    await assert.rejects(async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
      }
    });

    // The gateway must still be serving after a client walks away mid-stream.
    const health = await api('/api/system/health');
    assert.equal(health.status, 200);
  });

  /* ---------------- Autonomous coding pipeline ---------------- */

  it('runs the coding pipeline end to end and writes a real file', async () => {
    const { workspace } = await json<{ workspace: { id: string; path: string } }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-pipeline' }),
    });

    const { task } = await json<{ task: { id: string } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, request: 'Create a file `notes.md` describing the change.' }),
    });

    const deadline = Date.now() + 60_000;
    let status = 'queued';
    type TaskView = { task: { status: string; error: string | null }; steps: { role: string; status: string }[] };
    let detail: TaskView | null = null;
    while (Date.now() < deadline) {
      detail = await json<TaskView>(`/api/tasks/${task.id}`);
      status = detail.task.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(detail, 'the task should have been readable while polling');
    assert.equal(status, 'completed', `task did not complete: ${detail.task.error ?? 'timed out'}`);
    const roles = detail.steps.map((s) => s.role);
    for (const expected of ['planner', 'implementer', 'reviewer']) {
      assert.ok(roles.includes(expected), `the pipeline should have run a ${expected}, saw ${roles.join(', ')}`);
    }

    // The file has to exist on disk, not merely be claimed in a summary.
    const written = readFileSync(join(workspace.path, 'notes.md'), 'utf8');
    assert.ok(written.length > 0);

    const changes = await json<{ changes: { path: string; kind: string; state: string }[]; diff: string }>(
      `/api/workspaces/${workspace.id}/changes`,
    );
    assert.ok(
      changes.changes.some((c) => c.path === 'notes.md' && c.kind === 'added'),
      'the write must be recorded as a reviewable change',
    );
    assert.match(changes.diff, /\+\+\+ b\/notes\.md/);
  });

  /* ---------------- Usage accounting ---------------- */

  it('records every call in usage, attributed and costed at zero for local inference', async () => {
    const usage = await json<{
      summary: { totals: { requests: number; tokens: number; cost: number }; byProvider: { providerId: string; cost: number }[] };
      recent: { cost: number; providerId: string; taskId: string | null; agentRole: string | null }[];
    }>('/api/usage?limit=200');

    assert.ok(usage.summary.totals.requests > 0, 'the calls above should be recorded');
    assert.ok(usage.summary.totals.tokens > 0, 'token counts must come through from the provider');
    assert.equal(usage.summary.totals.cost, 0, 'local inference must never be reported as having cost money');
    assert.ok(
      usage.recent.every((r) => r.cost === 0),
      'no individual local call may be recorded with a cost',
    );
    // Agent work has to be attributable to the task and the agent that did it,
    // or per-task budgets and the usage screen are guesses.
    assert.ok(
      usage.recent.some((r) => r.taskId !== null && r.agentRole !== null),
      'pipeline calls must be attributed to their task and agent role',
    );
  });
});
