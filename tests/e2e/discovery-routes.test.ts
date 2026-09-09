import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';

/**
 * The discovery API, through the real gateway.
 *
 * Two things here are worth more than the route coverage.
 *
 * The **second boot** is tested. The first version of this wiring constructed
 * the discovery service before the credential resolver it closed over. With an
 * empty cache nothing was ranked and nothing noticed; with a populated cache
 * the closure ran during boot and the gateway died in the temporal dead zone,
 * before it could log why. First run fine, every run after it broken — which no
 * single-boot test would ever see.
 *
 * And **boot never touches the network**. A gateway that waits on GitHub to
 * start is a gateway that does not start when GitHub is down, so this asserts
 * that a fetch during construction would have been a test failure rather than
 * trusting the comment that says it does not happen.
 */
describe('The discovery API', () => {
  let app: App;
  let server: FastifyInstance;
  let dataDir: string;
  let fetchCalls = 0;

  function configFor(dir: string) {
    return loadConfig({
      MERIDIAN_DATA_DIR: dir,
      MERIDIAN_DB: join(dir, 'test.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dir, 'assets'),
      MERIDIAN_MASTER_KEY: 'discovery-route-test-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      PORT: '0',
    } as NodeJS.ProcessEnv);
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-discovery-routes-'));

    // A cache written by a previous run, so this boot is a *second* boot.
    // Loaded from the fixture rather than fetched, so the test says the same
    // thing on a machine with no network.
    const cacheDir = join(dataDir, 'discovery-cache');
    mkdirSync(cacheDir, { recursive: true });
    const fixture = join(import.meta.dirname, 'fixtures', 'discovery-cache');
    if (existsSync(fixture)) cpSync(fixture, cacheDir, { recursive: true });

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return realFetch(...args);
    }) as typeof fetch;

    app = await App.create(configFor(dataDir));
    server = await createServer(app);
    await server.ready();
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts without making a single outbound request', () => {
    // App.create() is the whole of boot. If this number is not zero, a gateway
    // somewhere is waiting on a third party to finish starting.
    assert.equal(fetchCalls, 0, `boot made ${fetchCalls} outbound requests`);
  });

  it('reports its sources, and says plainly that nothing has been refreshed yet', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/discovery/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status.everRanOnline, false);
    assert.match(body.note, /came from the on-disk cache/);
    assert.ok(body.status.sources.length >= 6, 'not every source is registered');
    for (const source of body.status.sources) {
      assert.ok(source.license, `${source.id} reports no licence`);
      assert.ok(source.attribution, `${source.id} reports no attribution`);
    }
  });

  it('serves a ranked free list, and explains what it left out', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/discovery/free?limit=5' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.models));
    assert.ok(Array.isArray(body.excluded), 'an empty result has to be explicable');
    // Descending, and every entry carries its own reasoning.
    for (let i = 1; i < body.models.length; i += 1) {
      assert.ok(body.models[i - 1].score >= body.models[i].score, 'the list is not in rank order');
    }
    for (const model of body.models) {
      assert.ok(['free', 'free-locally'].includes(model.verdict), `${model.modelId} is ${model.verdict} on a free list`);
      assert.ok(model.reasons.length > 0, `${model.modelId} scored with no stated reason`);
      assert.ok(model.provenance?.source, `${model.modelId} has no source cited`);
    }
  });

  it('never puts an unestablished cost on the free list', async () => {
    const free = (await server.inject({ method: 'GET', url: '/api/discovery/free?limit=500' })).json();
    const all = (await server.inject({ method: 'GET', url: '/api/discovery/free?limit=500&includeNonFree=true' })).json();
    const freeIds = new Set(free.models.map((m: { modelId: string }) => m.modelId));
    for (const model of all.models) {
      if (model.verdict === 'unknown' || model.verdict === 'paid' || model.verdict === 'free-while-credit-lasts') {
        assert.ok(!freeIds.has(model.modelId), `${model.modelId} is ${model.verdict} and appeared on the free list`);
      }
    }
  });

  it('lists providers and explains one of them', async () => {
    const list = (await server.inject({ method: 'GET', url: '/api/discovery/providers' })).json();
    assert.ok(list.providers.length > 0);
    const first = list.providers[0];

    const detail = await server.inject({ method: 'GET', url: `/api/discovery/providers/${first.providerId}` });
    assert.equal(detail.statusCode, 200);
    const body = detail.json();
    // The same field in the same place in both responses. Two endpoints
    // describing one thing differently is a branch every caller has to carry.
    assert.equal(body.provider.freeAccess, first.freeAccess);
    assert.equal(body.provider.accessLabel, first.accessLabel);
    assert.ok(Array.isArray(body.provider.origins), 'the merge is not shown');
  });

  it('says which source it does not know about, rather than an empty object', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/discovery/providers/not-a-real-provider' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /not-a-real-provider/);
  });

  it('publishes the attribution for everything it redistributes', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/discovery/attribution' });
    assert.equal(res.statusCode, 200);
    const { sources } = res.json();
    assert.ok(sources.length >= 6);
    for (const source of sources) {
      assert.ok(source.license && source.attribution, `${source.source} is missing its notice`);
    }
  });

  it('a second boot on the same data directory still starts', async () => {
    // The bug this exists for: the discovery service closed over the credential
    // resolver and was constructed before it. An empty cache ranks nothing and
    // hides it; a populated one runs the closure during boot and throws in the
    // temporal dead zone.
    const second = await App.create(configFor(dataDir));
    try {
      const status = second.freeInference.status();
      assert.ok(status.sources.length >= 6);
    } finally {
      await second.stop();
    }
  });
});
