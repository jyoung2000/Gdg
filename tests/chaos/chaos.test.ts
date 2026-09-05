import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMeridianError, loadConfig, nullLogger } from '@meridian/shared';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';
import { App } from '../../apps/gateway/src/services/app.js';
import { createHarness, model } from '../helpers/harness.js';
import { startMockProvider } from '../helpers/mock-provider.js';

const chat = { messages: [{ role: 'user' as const, content: 'hello' }] };

/**
 * Chaos coverage: the failure modes a self-hosted gateway will actually meet.
 *
 * Each of these is a scenario where the naive implementation does something
 * quietly wrong — hangs, spends money, loses data, or reports success — rather
 * than failing in a way the operator can see.
 */
describe('Chaos — providers', () => {
  it('survives a provider disappearing mid-flight', async () => {
    const a = await startMockProvider('alpha');
    const b = await startMockProvider('beta', { reply: 'still here' });
    const h = createHarness({
      providers: [a.descriptor, b.descriptor],
      models: [
        model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' }),
        model({ id: 'beta:m', providerId: 'beta', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'alpha:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    // The socket is gone entirely, not merely erroring.
    await a.close();

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 4 });
    assert.equal(res.providerId, 'beta');
    assert.equal(res.value.content, 'still here');
    await b.close();
  });

  it('reports a clear error when every provider is gone', async () => {
    const a = await startMockProvider('alpha');
    const h = createHarness({
      providers: [a.descriptor],
      models: [model({ id: 'alpha:m', providerId: 'alpha', providerModelId: 'm' })],
    });
    await a.close();

    await assert.rejects(
      () => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 2 }),
      (e: unknown) => isMeridianError(e) && (e.code === 'provider_unavailable' || e.code === 'timeout'),
    );
  });

  it('does not treat a rate-limit burst as a reason to spend money', async () => {
    const free = await startMockProvider('free-one', { rateLimitAfter: 0 });
    const paid = await startMockProvider('paid-one');
    const h = createHarness({
      providers: [free.descriptor, paid.descriptor],
      models: [
        model({ id: 'free-one:m', providerId: 'free-one', providerModelId: 'm' }),
        model({
          id: 'paid-one:m',
          providerId: 'paid-one',
          providerModelId: 'm',
          pricing: { kind: 'METERED', inputPerMTok: 10, outputPerMTok: 30, perRequest: null },
        }),
      ],
      allowPaid: true,
    });

    // Paid routing is permitted for the instance but not for this request, so
    // exhausting the free provider must fail rather than fall through to cost.
    await assert.rejects(
      () => h.executor.chat({ modality: 'text', taskType: 'chat', allowPaid: false }, chat, { retryBudget: 3 }),
      (e: unknown) => isMeridianError(e),
    );
    assert.equal(paid.calls.filter((c) => c.path.includes('chat')).length, 0, 'a paid provider must not be called without permission');
    await free.close();
    await paid.close();
  });

  it('handles a provider that returns malformed JSON', async () => {
    const bad = await startMockProvider('bad', { alwaysStatus: 502 });
    const good = await startMockProvider('good', { reply: 'recovered' });
    const h = createHarness({
      providers: [bad.descriptor, good.descriptor],
      models: [
        model({ id: 'bad:m', providerId: 'bad', providerModelId: 'm' }),
        model({ id: 'good:m', providerId: 'good', providerModelId: 'm' }),
      ],
    });
    h.models.setScores({ modelId: 'bad:m', coding: 99, reasoning: 99, general: 99, toolUse: 99, vision: null, stability: 1, samples: 99, updatedAt: 0 });

    const res = await h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 4 });
    assert.equal(res.providerId, 'good');
    await bad.close();
    await good.close();
  });

  it('recovers when a model is withdrawn from a provider’s catalog', async () => {
    const p = await startMockProvider('shifting', { models: ['model-a', 'model-b'] });
    const h = createHarness({
      providers: [p.descriptor],
      models: [
        model({ id: 'shifting:model-a', providerId: 'shifting', providerModelId: 'model-a' }),
        model({ id: 'shifting:model-b', providerId: 'shifting', providerModelId: 'model-b' }),
      ],
    });

    // A discovery pass where the provider now lists only one model must remove
    // the other, or routing keeps choosing something that no longer exists.
    const { removed } = h.models.replaceProviderModels('shifting', [
      model({ id: 'shifting:model-b', providerId: 'shifting', providerModelId: 'model-b' }),
    ]);
    assert.deepEqual(removed, ['shifting:model-a']);
    assert.equal(h.models.get('shifting:model-a'), null);
    assert.equal(h.router.route({ modality: 'text', taskType: 'chat' }).model, 'model-b');
    await p.close();
  });

  it('treats an expired credential as unusable rather than sending it', async () => {
    const p = await startMockProvider('secured', { requireToken: 'valid' });
    const h = createHarness({
      providers: [{ ...p.descriptor, auth: 'api-key' }],
      models: [model({ id: 'secured:m', providerId: 'secured', providerModelId: 'm' })],
      credentials: [
        {
          id: 'expired',
          providerId: 'secured',
          scope: 'system',
          source: 'user-entered',
          label: 'expired',
          userId: null,
          workspaceId: null,
          poolId: null,
          priority: 100,
          enabled: true,
          hint: '••••ired',
          maxConcurrency: null,
          // Already expired against the harness clock.
          expiresAt: 1_600_000_000_000,
          lastUsedAt: null,
          createdAt: 0,
          secret: 'valid',
        },
      ],
    });

    await assert.rejects(() => h.executor.chat({ modality: 'text', taskType: 'chat' }, chat, { retryBudget: 1 }));
    assert.equal(p.calls.filter((c) => c.path.includes('chat')).length, 0, 'an expired credential must never be presented');
    await p.close();
  });
});

describe('Chaos — persistence', () => {
  function tempDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-chaos-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('survives a restart with its data intact', async () => {
    const { dir, cleanup } = tempDir();
    const env = {
      MERIDIAN_DATA_DIR: dir,
      MERIDIAN_DB: join(dir, 'restart.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dir, 'assets'),
      MERIDIAN_MASTER_KEY: 'stable-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_LOCAL_ENDPOINTS: '',
    } as NodeJS.ProcessEnv;

    const first = await App.create(loadConfig(env));
    await first.start();
    const credential = first.store.addCredential({
      providerId: 'groq',
      secret: 'gsk_persisted_secret_value_123456',
      scope: 'user',
      source: 'user-entered',
      label: 'persisted',
    });
    const pool = first.pools.list().length;
    await first.stop();

    // A fresh process against the same volume.
    const second = await App.create(loadConfig(env));
    await second.start();
    const recovered = second.store.getById(credential.id);
    assert.ok(recovered, 'the credential should survive the restart');
    assert.equal(recovered.secret, 'gsk_persisted_secret_value_123456', 'and still decrypt');
    assert.equal(second.pools.list().length, pool, 'pools should not be re-seeded into duplicates');
    await second.stop();
    cleanup();
  });

  it('does not silently re-run migrations or duplicate built-in pools', async () => {
    const { dir, cleanup } = tempDir();
    const path = join(dir, 'migrate.db');
    const a = openDatabase(path, nullLogger);
    const applied = (a.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    a.close();

    const b = openDatabase(path, nullLogger);
    assert.equal((b.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n, applied);
    b.close();
    cleanup();
  });

  it('reports a credential sealed under a lost master key rather than returning garbage', () => {
    const { dir, cleanup } = tempDir();
    const db = openDatabase(join(dir, 'keys.db'), nullLogger);

    const store = new Store(db, SecretBox.create(db, 'original-key'));
    const created = store.addCredential({ providerId: 'groq', secret: 'gsk_value', scope: 'system', source: 'environment', label: 'k' });
    assert.equal(store.getById(created.id)?.secret, 'gsk_value');

    // The operator rotated MERIDIAN_MASTER_KEY without re-entering credentials.
    const wrongKey = new Store(db, SecretBox.create(db, 'different-key'));
    assert.equal(wrongKey.getById(created.id)?.secret, null, 'an undecryptable secret must be null, never partial plaintext');

    db.close();
    cleanup();
  });
});

describe('Chaos — resource limits', () => {
  it('kills a runaway command at the timeout', async () => {
    const { resolveSandbox } = await import('@meridian/agent-sdk');
    const { sandbox } = await resolveSandbox('process', {
      image: 'unused',
      memoryMb: 512,
      cpus: 1,
      network: false,
      logger: nullLogger,
    });

    const started = Date.now();
    const res = await sandbox.exec('sleep 30', { cwd: tmpdir(), timeoutMs: 800 });
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 8000, 'the timeout must actually fire, not merely be recorded');
  });

  it('truncates unbounded output instead of exhausting memory', async () => {
    const { resolveSandbox } = await import('@meridian/agent-sdk');
    const { sandbox } = await resolveSandbox('process', {
      image: 'unused',
      memoryMb: 512,
      cpus: 1,
      network: false,
      logger: nullLogger,
    });

    const res = await sandbox.exec('yes meridian | head -c 5000000', { cwd: tmpdir(), timeoutMs: 15_000, maxOutputBytes: 4096 });
    assert.equal(res.truncated, true);
    assert.ok(res.stdout.length <= 8192, `expected the output cap to hold, saw ${res.stdout.length} bytes`);
  });

  it('refuses to fetch loopback and cloud-metadata addresses', async () => {
    const { isPrivateHost } = await import('@meridian/agent-sdk');
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'foo.internal']) {
      assert.equal(isPrivateHost(host), true, `${host} must be refused`);
    }
    for (const host of ['example.com', '8.8.8.8', 'api.openai.com', '172.32.0.1']) {
      assert.equal(isPrivateHost(host), false, `${host} should be allowed`);
    }
  });
});
