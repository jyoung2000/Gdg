#!/usr/bin/env node
/**
 * Regenerate the offline artefacts, end to end, with one command.
 *
 * The mockup and its preview screenshots are captured from the *running*
 * application, which is what makes them faithful and is also why they went
 * stale: regenerating them meant building, starting a gateway, remembering
 * which port, running two scripts against it, and shutting it down again. That
 * is four steps too many, and the previews sat seven weeks behind the interface
 * they claimed to show.
 *
 * So this does all of it: build, boot a throwaway gateway on a free port in a
 * temporary data directory, capture the mockup, shoot the previews, stop the
 * gateway, and write the fingerprint sidecar the release gate reads. Nothing is
 * left running and nothing is written outside the repository's own artefacts.
 *
 *   pnpm mockup            build, then regenerate everything
 *   pnpm mockup --no-build use the dist/ that is already there
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiFingerprint } from './ui-fingerprint.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const skipBuild = process.argv.includes('--no-build');

/** A port nothing is listening on, asked for rather than assumed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} exited ${res.status ?? 'on a signal'}`);
    process.exit(res.status ?? 1);
  }
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the gateway exited (${child.exitCode}) before it was healthy`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the gateway never became healthy');
}

if (!skipBuild) run('node', ['scripts/build.mjs']);
if (!existsSync(join(ROOT, 'dist/web/index.html'))) {
  console.error('dist/web is missing — run without --no-build.');
  process.exit(1);
}

const port = await freePort();
const dataDir = mkdtempSync(join(tmpdir(), 'meridian-mockup-'));
console.log(`→ starting a throwaway gateway on ${port}`);

const gateway = spawn(process.execPath, ['dist/gateway/main.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port),
    MERIDIAN_DATA_DIR: dataDir,
    MERIDIAN_DB: join(dataDir, 'mockup.db'),
    MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
    MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
    MERIDIAN_MASTER_KEY: 'mockup-capture-key-not-a-secret',
    MERIDIAN_LOG_LEVEL: 'error',
    // Nothing on a timer: a capture should not depend on what a refresh
    // happened to fetch while the browser was walking the screens.
    MERIDIAN_HEALTH_INTERVAL_MS: '0',
    MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
  },
});
let gatewayLog = '';
gateway.stdout.on('data', (c) => (gatewayLog += c));
gateway.stderr.on('data', (c) => (gatewayLog += c));

const stop = () => {
  if (gateway.exitCode === null) gateway.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

try {
  await waitForHealth(`http://127.0.0.1:${port}/api/health`, gateway);
  console.log('→ capturing the mockup');
  run('npx', ['tsx', 'scripts/capture-gui-mockup.mts', `http://127.0.0.1:${port}`]);
  console.log('→ shooting the previews from the running app');
  run('node', ['scripts/shoot-previews.mjs', `http://127.0.0.1:${port}`]);
} catch (e) {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  if (gatewayLog.trim()) console.error(gatewayLog.trim().split('\n').slice(-15).join('\n'));
  process.exit(1);
} finally {
  stop();
}

// A PNG cannot carry a comment, so the previews' fingerprint lives beside them.
// Without it the release gate could tell the mockup was stale and could say
// nothing at all about the pictures people actually look at.
const fp = uiFingerprint(ROOT);
writeFileSync(
  join(ROOT, 'docs/mockup/previews.json'),
  `${JSON.stringify({ uiFingerprint: fp.hash, uiSourceFiles: fp.files }, null, 2)}\n`,
);
console.log(`\nmockup, previews and previews.json all at ui ${fp.hash}`);
