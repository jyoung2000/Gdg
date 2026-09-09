#!/usr/bin/env node
/**
 * Prove the desktop payload is complete, by running it.
 *
 * A packaging script that copies files can only be wrong in one direction —
 * something is missing — and that is invisible until an end user's machine
 * refuses to start. The check that means anything is booting the payload with
 * its own bundled runtime, from a directory that is not the repository, and
 * asking the gateway whether it is ready.
 *
 * Structural checks come first because they say *what* is wrong; the boot says
 * *whether* anything is. Both run. When the payload targets a different
 * platform than this host — a Windows payload cross-built on Linux — the
 * structural checks still run in full and the boot is reported as not attempted
 * rather than skipped quietly, because a silently skipped verification reads
 * exactly like a passing one.
 *
 *   node scripts/verify-desktop-payload.mjs
 *   node scripts/verify-desktop-payload.mjs --payload apps/desktop/payload
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const payloadDir = resolve(flag('payload', join(ROOT, 'apps/desktop/payload')));
const failures = [];
const notes = [];

function check(name, ok, detail = '') {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(join(payloadDir, 'payload.json'))) {
  process.stderr.write(`\nverify-desktop-payload: no payload at ${payloadDir}\nRun: node scripts/package-desktop.mjs\n\n`);
  process.exit(1);
}
const payload = JSON.parse(readFileSync(join(payloadDir, 'payload.json'), 'utf8'));

process.stdout.write(`\nMeridian desktop payload — ${payload.platform}-${payload.arch}, built on ${payload.builtOn}\n\n`);

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

for (const relPath of [payload.node.binary, payload.server.entry, payload.native['better-sqlite3'].binary, 'server/web/index.html', payload.server.migrations]) {
  check(`present: ${relPath}`, existsSync(join(payloadDir, relPath)));
}

// The web client is not one file, and an empty assets directory would still
// pass an index.html check while rendering a blank window.
const assets = existsSync(join(payloadDir, 'server/web/assets')) ? readdirSync(join(payloadDir, 'server/web/assets')) : [];
check('web client has its bundles', assets.some((f) => f.endsWith('.js')) && assets.some((f) => f.endsWith('.css')), `${assets.length} assets`);

// Every migration, not merely the directory. A payload one migration short
// starts, applies what it has, and leaves a schema the code expects more from.
const shipped = existsSync(join(payloadDir, payload.server.migrations)) ? readdirSync(join(payloadDir, payload.server.migrations)).filter((f) => f.endsWith('.sql')) : [];
const inRepo = readdirSync(join(ROOT, 'database/migrations')).filter((f) => f.endsWith('.sql'));
check('every migration is in the payload', shipped.length === inRepo.length, `${shipped.length} of ${inRepo.length}`);

/**
 * Is this binary built for the platform the payload targets?
 *
 * Getting this wrong is the single most likely packaging mistake: a Linux
 * `better_sqlite3.node` copied into a Windows payload by a cross-build looks
 * completely fine on disk and fails at `require` on the user's machine with an
 * error most people would read as a corrupt install. The magic bytes settle it
 * without running anything.
 */
function binaryFormat(path) {
  const head = readFileSync(path).subarray(0, 4);
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe'; // MZ — Windows
  if (head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF') return 'elf'; // Linux
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe].includes(head.readUInt32BE(0)) || head.readUInt32LE(0) === 0xfeedfacf) return 'macho';
  return 'unknown';
}

const expectedFormat = payload.platform === 'win32' ? 'pe' : payload.platform === 'darwin' ? 'macho' : 'elf';
for (const [label, relPath] of [
  ['node runtime', payload.node.binary],
  ['better-sqlite3 native addon', payload.native['better-sqlite3'].binary],
]) {
  const actual = binaryFormat(join(payloadDir, relPath));
  check(`${label} is built for ${payload.platform}`, actual === expectedFormat, `${actual}, expected ${expectedFormat}`);
}

/**
 * Nothing in the payload may be a secret or a local artefact.
 *
 * The payload is copied into an installer and shipped to strangers. A stray
 * `.env`, a database from a developer's machine, or a credential in a config
 * file would be published, not merely misplaced.
 */
const forbidden = [];
(function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (/^\.env|\.db$|\.sqlite3?$|\.pem$|\.key$|id_rsa|\.p12$|\.pfx$/i.test(entry.name)) forbidden.push(full);
  }
})(payloadDir);
check('no credentials, keys or local databases in the payload', forbidden.length === 0, forbidden.join(', '));

// Size, because an installer that quietly grew to a gigabyte is a regression
// somebody should have to notice deliberately.
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}
const megabytes = dirSize(payloadDir) / 1024 / 1024;
check('payload is a plausible size', megabytes > 40 && megabytes < 400, `${megabytes.toFixed(1)} MB`);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const canBoot = payload.platform === process.platform && payload.arch === process.arch;

if (!canBoot) {
  notes.push(
    `The payload targets ${payload.platform}-${payload.arch} and this host is ${process.platform}-${process.arch}, ` +
      `so it was NOT booted here. Structural checks above passed; whether it starts is answered by the ` +
      `${payload.platform} job, and by nothing else.`,
  );
} else {
  const workdir = mkdtempSync(join(tmpdir(), 'meridian-payload-'));
  try {
    const result = await boot(workdir);
    check('the bundled runtime starts the gateway', result.ok, result.detail);
    if (result.ok) {
      check('the database was created by the bundled native addon', result.dbCreated, result.dbDetail);
      check('the web client is served', result.webOk, result.webDetail);
      // A fresh install has no providers and therefore no models, so readiness
      // answers 503 — correctly. That is the normal first-run state, and it is
      // why the desktop shell gates its window on liveness and then shows
      // onboarding: gating on readiness would leave a new user staring at a
      // splash screen until they had configured something they cannot reach.
      check('readiness reports honestly on a fresh install', result.readyStatus === 503 || result.readyStatus === 200, `${result.readyStatus}: ${result.readyDetail}`);
      check('onboarding says what a fresh install still needs', result.onboardingOk, result.onboardingDetail);
      check('it stops when asked over stdin', result.stopped, result.stopDetail);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function boot(workdir) {
  const node = join(payloadDir, payload.node.binary);
  const entry = join(payloadDir, payload.server.entry);
  const child = spawn(node, [entry], {
    // Deliberately not the repository: the payload must not be able to reach
    // anything outside itself, and a cwd inside the checkout would let a
    // missing module resolve through the workspace's own node_modules and pass
    // a test it should fail.
    cwd: workdir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      MERIDIAN_DESKTOP: '1',
      MERIDIAN_DATA_DIR: join(workdir, 'data'),
      MERIDIAN_WEB_ROOT: join(payloadDir, 'server/web'),
      MERIDIAN_MIGRATIONS_DIR: join(payloadDir, payload.server.migrations),
      MERIDIAN_RUNTIME_STATE: join(workdir, 'instance.json'),
      MERIDIAN_MASTER_KEY: 'payload-verification-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: '',
      PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));

  const state = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), 90_000);
    child.stdout.on('data', () => {
      const line = stdout.split('\n').find((l) => l.startsWith('meridian-ready '));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(line.slice('meridian-ready '.length)));
      } catch {
        resolvePromise(null);
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
  });

  if (!state) {
    if (child.exitCode === null) child.kill('SIGKILL');
    return {
      ok: false,
      detail: `the gateway never announced. stderr: ${stderr.slice(0, 800) || '(empty)'}`,
    };
  }

  // Liveness, not readiness: "the process is serving HTTP" is what proves the
  // payload is complete. Whether it has anything to route to is a question
  // about the user's configuration, not about the bundle.
  const health = await fetch(`${state.url}/api/system/health`).then((r) => r.status).catch(() => 0);
  const ready = await fetch(`${state.url}/api/system/ready`)
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .catch(() => ({ status: 0, body: '' }));
  const onboarding = await fetch(`${state.url}/api/onboarding`)
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .catch(() => ({ status: 0, body: '' }));
  const web = await fetch(`${state.url}/`).then(async (r) => ({ status: r.status, body: await r.text() })).catch(() => ({ status: 0, body: '' }));
  const dbPath = join(workdir, 'data', 'meridian.db');
  const dbCreated = existsSync(dbPath) && statSync(dbPath).size > 0;

  child.stdin.write('shutdown\n');
  const code = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), 30_000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolvePromise(c);
    });
  });
  if (child.exitCode === null) child.kill('SIGKILL');

  const readyChecks = (() => {
    try {
      return (JSON.parse(ready.body).checks ?? []).map((c) => `${c.name}=${c.ok ? 'ok' : 'no'}`).join(' ');
    } catch {
      return ready.body.slice(0, 120);
    }
  })();

  return {
    ok: health === 200,
    detail: `health returned ${health} on ${state.url}`,
    readyStatus: ready.status,
    readyDetail: readyChecks,
    onboardingOk: onboarding.status === 200 && onboarding.body.includes('"'),
    onboardingDetail: `GET /api/onboarding returned ${onboarding.status}`,
    dbCreated,
    dbDetail: dbCreated ? `${(statSync(dbPath).size / 1024).toFixed(0)} KB at ${dbPath}` : 'the database file was never written',
    webOk: web.status === 200 && web.body.includes('<div id="root"'),
    webDetail: `GET / returned ${web.status}, ${web.body.length} bytes`,
    stopped: code === 0,
    stopDetail: code === null ? 'it did not exit within 30s' : `exit code ${code}`,
  };
}

/* ------------------------------------------------------------------ */

process.stdout.write('\n');
for (const note of notes) process.stdout.write(`  note: ${note}\n`);
if (failures.length) {
  process.stdout.write(`\n  ${failures.length} check(s) failed:\n`);
  for (const f of failures) process.stdout.write(`    - ${f}\n`);
  process.stdout.write('\n');
  process.exit(1);
}
process.stdout.write(`\n  payload verified${canBoot ? ' and booted' : ' structurally (not booted on this host)'}\n\n`);
