import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer as createGateway } from '../../apps/gateway/src/server.js';

/**
 * What the gateway's rate limit actually covers.
 *
 * It used to cover `/v1` and `/anthropic` and nothing else, so every other way
 * to make Meridian call a provider — an agent task, a benchmark, a comparison,
 * an image job, a verification probe — could be driven as fast as a client
 * could type. The limit is on the gateway to protect the operator's money and
 * their providers' patience, and it only does that if it covers the routes
 * that spend.
 */
describe('Rate limiting', () => {
  let app: App;
  let server: FastifyInstance;
  let dataDir: string;
  let base: string;

  const LIMIT = 5;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-ratelimit-'));
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'rl.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'rate-limit-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_RATE_LIMIT: String(LIMIT),
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createGateway(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const statuses = async (n: number, path: string, init: RequestInit): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
      out.push(res.status);
      await res.text();
    }
    return out;
  };

  it('meters a route that spends money even though it is not /v1', async () => {
    // The model does not exist, so nothing is actually called: what is being
    // measured is whether the request was counted, not what it did.
    const codes = await statuses(LIMIT + 3, '/api/models/benchmark', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'does-not-exist:model' }),
    });
    assert.ok(codes.includes(429), `no request was throttled: ${codes.join(', ')}`);
  });

  it('does not throttle reading, which costs nothing and is most of what a UI does', async () => {
    // Same client, well past the limit, immediately after exhausting it above.
    const codes = await statuses(LIMIT * 4, '/api/models', { method: 'GET' });
    assert.ok(!codes.includes(429), `reads were throttled: ${codes.join(', ')}`);
  });

  it('still keeps the liveness probe answering while the client is throttled', async () => {
    // A load balancer polls this on a timer. Throttling it turns a busy
    // gateway into one that looks dead and gets taken out of rotation.
    const codes = await statuses(LIMIT * 2, '/api/health', { method: 'GET' });
    assert.deepEqual([...new Set(codes)], [200], `the health probe was throttled: ${codes.join(', ')}`);
  });
});
