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
 * The control plane against a running gateway and a real inference server.
 *
 * The question these tests exist to answer is the one the whole feature turns
 * on: does an assignment made through the API actually change what the model
 * receives? A settings screen whose toggles do not reach the runtime is the
 * failure mode worth spending an end-to-end test on, so the decisive case
 * asserts on the model's own output rather than on the resolver's opinion of
 * itself.
 */
describe('AI control plane', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let url: string;
  let chatModel: string;

  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const ask = async (model: string): Promise<string> => {
    const res = await call<{ choices: { message: { content: string } }[] }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
    });
    return res.choices[0].message.content;
  };

  const boot = async (): Promise<void> => {
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'cp.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'control-plane-test-key',
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
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-cp-'));
    sim = await startSimServer();
    await boot();
    const { models } = await call<{ models: { id: string }[] }>('/api/models?limit=50');
    chatModel = models.find((m) => m.id.includes('sim-chat'))!.id;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds its builtin skills exactly once', async () => {
    const { skills } = await call<{ skills: { slug: string; source: string }[] }>('/api/skills');
    assert.ok(skills.length >= 5, 'builtin skills are present');
    assert.ok(skills.every((s) => s.source === 'builtin'));
    assert.equal(new Set(skills.map((s) => s.slug)).size, skills.length, 'no duplicates');
  });

  it('records capability provenance from the live provider listing', async () => {
    const detail = await call<{ capabilities: { capability: string; state: string; source: string }[] }>(
      `/api/models/${encodeURIComponent(chatModel)}/capabilities`,
    );
    const text = detail.capabilities.find((c) => c.capability === 'text')!;
    assert.equal(text.state, 'provider_declared');
    assert.match(text.source, /listing/);
    // Nothing has claimed video generation, so it must read unknown — not
    // "unsupported", which would be a claim nobody made.
    assert.equal(detail.capabilities.find((c) => c.capability === 'video-generation')!.state, 'unknown');
  });

  it('lets an operator confirm a capability, outranking the earlier evidence', async () => {
    await call(`/api/models/${encodeURIComponent(chatModel)}/capabilities`, {
      method: 'POST',
      body: JSON.stringify({ capability: 'reasoning', supported: true }),
    });
    const detail = await call<{ capabilities: { capability: string; state: string }[] }>(
      `/api/models/${encodeURIComponent(chatModel)}/capabilities`,
    );
    assert.equal(detail.capabilities.find((c) => c.capability === 'reasoning')!.state, 'user_confirmed');
  });

  /**
   * The decisive test. A skill carrying a sim directive changes the model's
   * reply, so the reply itself is the evidence that the assignment reached the
   * runtime — not the resolver agreeing with itself.
   */
  it('makes an assignment change what the model actually receives', async () => {
    await call('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ slug: 'e2e-proof', name: 'Proof', content: '[[sim: say ASSIGNMENT-REACHED-THE-MODEL]]' }),
    });

    assert.doesNotMatch(await ask(chatModel), /ASSIGNMENT-REACHED-THE-MODEL/, 'an unassigned skill must not reach the model');

    await call('/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'skill', targetId: 'e2e-proof', scope: 'global', mode: 'include' }),
    });
    assert.match(await ask(chatModel), /ASSIGNMENT-REACHED-THE-MODEL/, 'a globally assigned skill reaches the model');

    await call('/api/assignments', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'skill', targetId: 'e2e-proof', scope: 'model', scopeId: chatModel, mode: 'exclude' }),
    });
    assert.doesNotMatch(await ask(chatModel), /ASSIGNMENT-REACHED-THE-MODEL/, 'a model-scoped exclusion overrides the global rule');
  });

  it('explains every resolution in words', async () => {
    const { config, explanations } = await call<{
      config: { skills: { skill: { slug: string } }[]; excludedSkills: { targetId: string }[] };
      explanations: { skills: Record<string, string>; excludedSkills: Record<string, string> };
    }>(`/api/runtime/effective-config?modelId=${encodeURIComponent(chatModel)}`);

    assert.match(explanations.excludedSkills['e2e-proof'], /Excluded by model/);
    for (const s of config.skills) assert.ok(explanations.skills[s.skill.slug], 'every active skill carries its reason');
  });

  it('derives a requirement from a plain-language question and explains misses', async () => {
    const result = await call<{
      requirement: { capabilities: string[] };
      matches: { modelId: string; eligible: boolean; reasons: string[] }[];
    }>('/api/runtime/capability-search', { method: 'POST', body: JSON.stringify({ query: 'analyze an image and browse the web' }) });

    assert.ok(result.requirement.capabilities.includes('vision'));
    assert.ok(result.requirement.capabilities.includes('tools'));
    assert.ok(result.matches.every((m) => m.reasons.length > 0), 'every match says why it matched or missed');
  });

  it('states what a connection grants without overstating it', async () => {
    const { connections } = await call<{ connections: { providerId: string; method: string; grants: string }[] }>('/api/connections');
    const local = connections.find((c) => c.method === 'local');
    assert.ok(local, 'the local sim provider is reported as local');
    assert.match(local!.grants, /Nothing leaves it/);
    // An API-key provider must never be described as a subscription.
    for (const c of connections.filter((x) => x.method === 'api_key')) {
      assert.match(c.grants, /not a consumer subscription/);
    }
  });

  it('keeps assignments and skills across a restart', async () => {
    await server.close();
    await app.stop();
    await boot();

    const { skills } = await call<{ skills: { slug: string }[] }>('/api/skills');
    assert.ok(skills.some((s) => s.slug === 'e2e-proof'), 'a created skill survives a restart');

    const { assignments } = await call<{ assignments: { targetId: string; scope: string; mode: string }[] }>('/api/assignments');
    const global = assignments.find((a) => a.targetId === 'e2e-proof' && a.scope === 'global');
    const scoped = assignments.find((a) => a.targetId === 'e2e-proof' && a.scope === 'model');
    assert.equal(global?.mode, 'include');
    assert.equal(scoped?.mode, 'exclude');

    // And the behaviour, not just the rows, is restored.
    assert.doesNotMatch(await ask(chatModel), /ASSIGNMENT-REACHED-THE-MODEL/);
  });
});
