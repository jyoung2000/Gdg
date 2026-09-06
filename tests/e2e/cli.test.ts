import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

const exec = promisify(execFile);
const CLI = resolve(process.cwd(), 'apps/cli/src/uag.ts');

/**
 * The `uag` CLI against a running gateway.
 *
 * Spawned as a real process against a real server, because that is the only way
 * to catch what actually breaks a CLI: an unset base URL, a response shape it
 * did not expect, a command that parses its arguments differently from the way
 * the help text describes.
 */
describe('CLI', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let home: string;
  let url: string;

  const uag = async (...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const res = await exec(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), CLI, ...args], {
        // HOME is redirected so the CLI's own config file cannot leak between
        // this test and the developer running it.
        env: { ...process.env, MERIDIAN_URL: url, HOME: home },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { ...res, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
    }
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-cli-'));
    home = mkdtempSync(join(tmpdir(), 'meridian-cli-home-'));
    sim = await startSimServer();

    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'cli.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'cli-test-master-key',
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
    rmSync(home, { recursive: true, force: true });
  });

  it('reports the instance it is talking to', async () => {
    const res = await uag('status');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Meridian/);
    assert.match(res.stdout, /Providers/);
    assert.match(res.stdout, /Models/);
    // The sandbox posture has to be visible, since it is not isolation here.
    assert.match(res.stdout, /process/);
  });

  it('lists models, providers and pools from the live instance', async () => {
    const models = await uag('models', '--limit', '5');
    assert.equal(models.code, 0, models.stderr);
    assert.match(models.stdout, /meridian-sim-chat/);
    assert.match(models.stdout, /LOCAL/, 'local models must not be shown as costing money');

    const providers = await uag('providers');
    assert.equal(providers.code, 0, providers.stderr);
    assert.match(providers.stdout, /not_configured/, 'uncredentialed providers must be shown as such');

    const pools = await uag('pools');
    assert.equal(pools.code, 0, pools.stderr);
    assert.match(pools.stdout, /Coding/);
  });

  it('completes a chat and reports what it cost', async () => {
    const res = await uag('chat', 'hello from the CLI test');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /meridian-sim: hello from the CLI test/);
    assert.match(res.stdout, /tokens/);
    assert.match(res.stdout, /\$0\.00/, 'local inference must be reported as free');
  });

  it('explains a misused command instead of failing silently', async () => {
    const res = await uag('compare', 'say hi');
    assert.notEqual(res.code, 0, 'a missing required option must be an error');
    assert.match(`${res.stdout}${res.stderr}`, /Usage: uag compare/, 'the error must show the correct usage');
  });

  it('runs a coding task and reports the files it changed', async () => {
    const created = await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli-task' }),
    });
    const { workspace } = (await created.json()) as { workspace: { id: string; path: string } };

    const res = await uag('code', 'Create a file `from-cli.md` with a short note.', '--workspace', workspace.id);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Implementer/);
    assert.match(res.stdout, /from-cli\.md/);
    assert.match(res.stdout, /Review the diff/, 'the CLI must not imply the change was accepted');
    assert.ok(existsSync(join(workspace.path, 'from-cli.md')), 'the file must exist on disk, not only in the summary');
  });

  it('prints help that names every command it implements', async () => {
    const res = await uag('help');
    assert.equal(res.code, 0, res.stderr);
    for (const command of ['chat', 'code', 'models', 'providers', 'pools', 'status', 'usage', 'task', 'compare']) {
      assert.match(res.stdout, new RegExp(`\\b${command}\\b`), `help omits "${command}"`);
    }
  });
});
