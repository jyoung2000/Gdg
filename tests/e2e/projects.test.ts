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
 * Projects, against a running gateway and a real inference server.
 *
 * A project is only real if its files and instructions actually reach the
 * model. These tests prove exactly that, without trusting a return value: the
 * sim server honours a `[[sim: say <text>]]` directive found in any system or
 * user message, so a directive placed in a project's *file* — or its
 * instruction file — can only come back as the reply if the gateway genuinely
 * delivered that content to the model. The control case (no project selected)
 * must not produce the marker, so the effect is attributable to the project and
 * nothing else.
 */
describe('Projects give the model shared context', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let url: string;

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET';
    const res = await fetch(`${url}${path}`, {
      ...init,
      body: init.body ?? (method === 'GET' ? undefined : '{}'),
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const ask = async (prompt: string, workspaceId: string | null): Promise<string> => {
    const res = await call<{ choices: { message: { content: string } }[] }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: prompt }],
        ...(workspaceId ? { meridian: { workspace_id: workspaceId } } : {}),
      }),
    });
    return res.choices[0].message.content;
  };

  const makeProject = async (name: string): Promise<string> => {
    const res = await call<{ workspace: { id: string } }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    return res.workspace.id;
  };

  const putFile = (id: string, path: string, content: string): Promise<unknown> =>
    call(`/api/workspaces/${id}/file`, { method: 'PUT', body: JSON.stringify({ path, content }) });

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-projects-'));
    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'projects.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'projects-test-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
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

  it("delivers a project file's contents to the model", async () => {
    const id = await makeProject('Docs project');
    // The directive lives in a data file, not the instructions — so a reply of
    // the marker proves the folder's files themselves were handed to the model.
    await putFile(id, 'facts.md', 'Project fact sheet. [[sim: say FILE_KNOWLEDGE_REACHED]]');

    const withProject = await ask('What do the project files say?', id);
    assert.match(withProject, /FILE_KNOWLEDGE_REACHED/, 'the file content reached the model');

    // Control: without the project, the same question cannot surface the marker.
    const without = await ask('What do the project files say?', null);
    assert.doesNotMatch(without, /FILE_KNOWLEDGE_REACHED/, 'nothing leaks in when no project is active');
  });

  it('applies a project\'s standing instructions', async () => {
    const id = await makeProject('Instructed project');
    await putFile(id, 'MERIDIAN.md', 'Always follow the house style. [[sim: say INSTRUCTIONS_APPLIED]]');

    const reply = await ask('Proceed.', id);
    assert.match(reply, /INSTRUCTIONS_APPLIED/, 'the MERIDIAN.md instructions were prepended for the model');
  });

  it('reaches the model through every dialect, not just the OpenAI one', async () => {
    // Three surfaces accept `meridian.workspace_id` and say nothing about
    // ignoring it. They used to disagree about what they did with it —
    // /v1/chat/completions applied the project, /anthropic/v1/messages applied
    // skills only, /v1/responses applied neither — so whether a project
    // reached the model depended on which dialect the client spoke.
    const id = await makeProject('Every dialect');
    await putFile(id, 'facts.md', 'Shared brief. [[sim: say DIALECT_PARITY_REACHED]]');

    const responses = await call<{ output_text: string }>('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', input: 'What does the brief say?', meridian: { workspace_id: id } }),
    });
    assert.match(responses.output_text, /DIALECT_PARITY_REACHED/, '/v1/responses ignored the project it was given');

    const anthropic = await call<{ content: { text: string }[] }>('/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'auto',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'What does the brief say?' }],
        meridian: { workspace_id: id },
      }),
    });
    assert.match(anthropic.content.map((c) => c.text).join(' '), /DIALECT_PARITY_REACHED/, '/anthropic/v1/messages ignored the project it was given');

    // And the surface that always worked still does, so this is parity rather
    // than three broken paths agreeing.
    assert.match(await ask('What does the brief say?', id), /DIALECT_PARITY_REACHED/);
  });

  it('an empty project changes nothing', async () => {
    // A project with no instruction file and no files must not inject an empty
    // context block or otherwise alter the request.
    const id = await makeProject('Empty project');
    const reply = await ask('Say the word ok. [[sim: say ok]]', id);
    assert.match(reply, /ok/, 'an empty project is a no-op, not an error');
  });
});
