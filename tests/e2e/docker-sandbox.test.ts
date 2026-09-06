import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nullLogger } from '@meridian/shared';
import { DockerSandbox, resolveSandbox } from '@meridian/agent-sdk';

const exec = promisify(execFile);

/**
 * The Docker sandbox's isolation, exercised against a real container.
 *
 * Everything the sandbox claims — no network, a read-only root, dropped
 * capabilities, hard memory and process limits, a workspace that is the only
 * writable place, and an environment built from scratch rather than inherited —
 * is a flag on a `docker run` invocation. Flags are easy to get wrong and
 * impossible to verify by reading, so each one is checked here by having a
 * command inside the container try the thing the flag forbids.
 *
 * Requires an image tagged by MERIDIAN_TEST_SANDBOX_IMAGE (default
 * `meridian-sandbox:offline-test`, built by
 * `node scripts/build-sandbox-image.mjs --offline`). When Docker or the image
 * is absent the suite skips — loudly, with the reason, because a silently
 * skipped security test reads exactly like a passing one.
 */
const IMAGE = process.env.MERIDIAN_TEST_SANDBOX_IMAGE ?? 'meridian-sandbox:offline-test';

async function unavailableReason(): Promise<string | null> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  } catch {
    return 'the Docker daemon is not reachable';
  }
  try {
    await exec('docker', ['image', 'inspect', IMAGE], { timeout: 15_000 });
  } catch {
    return `the image "${IMAGE}" is not present — build it with: node scripts/build-sandbox-image.mjs --offline`;
  }
  return null;
}

describe('Docker sandbox isolation', async () => {
  const skip = await unavailableReason();
  let dir: string;
  let sandbox: DockerSandbox;

  before(() => {
    if (skip) return;
    dir = mkdtempSync(join(tmpdir(), 'meridian-sbx-'));
    writeFileSync(join(dir, 'input.txt'), 'from the host\n');
    sandbox = new DockerSandbox({ image: IMAGE, memoryMb: 256, cpus: 1, network: false, logger: nullLogger, workspaceRoot: dir });
  });

  after(() => {
    if (!skip && dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reports the image and daemon it needs, rather than failing at run time', { skip: skip ?? false }, async () => {
    assert.equal(await sandbox.diagnose(), null, 'the configured image should be usable');

    const missing = new DockerSandbox({
      image: 'meridian-sandbox:definitely-not-built',
      memoryMb: 256,
      cpus: 1,
      network: false,
      logger: nullLogger,
    });
    const reason = await missing.diagnose();
    assert.ok(reason, 'a missing image must be diagnosed');
    assert.match(reason, /not present/);
    assert.match(reason, /docker build/, 'the diagnosis must say how to fix it');

    // And the resolver must degrade honestly rather than pretending to isolate.
    const resolved = await resolveSandbox('docker', {
      image: 'meridian-sandbox:definitely-not-built',
      memoryMb: 256,
      cpus: 1,
      network: false,
      logger: nullLogger,
      workspaceRoot: dir,
    });
    assert.equal(resolved.degraded, true);
    assert.equal(resolved.sandbox.kind, 'process');
    assert.match(resolved.reason ?? '', /not a security boundary/);
  });

  it('detects a workspace path that means something else to the Docker daemon', { skip: skip ?? false }, async () => {
    // Exactly what a containerised gateway hits: the path it passes to `-v` is
    // resolved against the host, so the daemon mounts an empty directory it
    // just created and every command runs against nothing while succeeding.
    const misconfigured = new DockerSandbox({
      image: IMAGE,
      memoryMb: 256,
      cpus: 1,
      network: false,
      logger: nullLogger,
      workspaceRoot: dir,
      hostWorkspaceRoot: '/definitely/not/where/this/lives',
    });

    const reason = await misconfigured.diagnose();
    assert.ok(reason, 'the probe must catch a mount that does not reach the workspace');
    assert.match(reason, /did not see the workspace/);
    assert.match(reason, /MERIDIAN_WORKSPACE_HOST_ROOT/, 'the diagnosis must name the setting that fixes it');
  });

  it('translates a container path to its host path when told where the workspace lives', { skip: skip ?? false }, () => {
    const translating = new DockerSandbox({
      image: IMAGE,
      memoryMb: 256,
      cpus: 1,
      network: false,
      logger: nullLogger,
      workspaceRoot: '/workspaces',
      hostWorkspaceRoot: '/srv/meridian/workspaces',
    });
    assert.equal(translating.hostPathFor('/workspaces/ws_abc'), '/srv/meridian/workspaces/ws_abc');
    assert.equal(translating.hostPathFor('/workspaces'), '/srv/meridian/workspaces');
    // Nothing sensible to translate to outside the root, so it passes through.
    assert.equal(translating.hostPathFor('/elsewhere/x'), '/elsewhere/x');
  });

  it('runs the command inside a container against the mounted workspace', { skip: skip ?? false }, async () => {
    const res = await sandbox.exec('cat input.txt; pwd', { cwd: dir, timeoutMs: 60_000 });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /from the host/);
    assert.match(res.stdout, /\/work/, 'the workspace is mounted at /work inside the container');
  });

  it('lets the command write to the workspace and nowhere else', { skip: skip ?? false }, async () => {
    const written = await sandbox.exec('touch /work/created-inside && echo ok', { cwd: dir, timeoutMs: 60_000 });
    assert.equal(written.exitCode, 0, written.stderr);
    // The file must land on the host: a sandbox whose writes vanish is useless.
    assert.doesNotThrow(() => readFileSync(join(dir, 'created-inside')));

    const rootfs = await sandbox.exec('touch /should-not-exist 2>&1 || echo REFUSED', { cwd: dir, timeoutMs: 60_000 });
    assert.match(rootfs.stdout, /REFUSED|Read-only file system/, 'the root filesystem must be read-only');

    // /tmp is the one exception, and it is noexec and disappears with the container.
    const scratch = await sandbox.exec('touch /tmp/scratch && echo ok', { cwd: dir, timeoutMs: 60_000 });
    assert.equal(scratch.exitCode, 0, scratch.stderr);
    const gone = await sandbox.exec('ls /tmp/scratch 2>&1 || echo ABSENT', { cwd: dir, timeoutMs: 60_000 });
    assert.match(gone.stdout, /ABSENT|No such file/, 'each command gets a fresh container, so /tmp does not persist');
  });

  it('gives the command no network', { skip: skip ?? false }, async () => {
    // With --network none the container has loopback and nothing else, so its
    // own interface list is the check that needs no external host to be up.
    const res = await sandbox.exec('cat /proc/net/route 2>/dev/null | wc -l', { cwd: dir, timeoutMs: 60_000 });
    assert.equal(res.exitCode, 0, res.stderr);
    // One header line and no routes: nothing to send a packet through.
    assert.equal(res.stdout.trim(), '1', `expected no routes, saw:\n${res.stdout}`);
  });

  it('does not hand the gateway\'s environment to the command', { skip: skip ?? false }, async () => {
    process.env.MERIDIAN_SANDBOX_LEAK_CANARY = 'sk-should-never-appear';
    try {
      const res = await sandbox.exec('env', { cwd: dir, timeoutMs: 60_000 });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.ok(
        !res.stdout.includes('sk-should-never-appear'),
        `the gateway's own environment must not reach a sandboxed command:\n${res.stdout}`,
      );
      assert.ok(!/API_KEY|TOKEN|SECRET/i.test(res.stdout), `no credential-shaped variables should be present:\n${res.stdout}`);
    } finally {
      delete process.env.MERIDIAN_SANDBOX_LEAK_CANARY;
    }
  });

  it('passes only the environment the caller asked for', { skip: skip ?? false }, async () => {
    const res = await sandbox.exec('echo "[$EXPLICIT]"', { cwd: dir, timeoutMs: 60_000, env: { EXPLICIT: 'passed-through' } });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /\[passed-through\]/);
  });

  it('kills a command that runs past its timeout', { skip: skip ?? false }, async () => {
    const started = Date.now();
    const res = await sandbox.exec('sleep 30', { cwd: dir, timeoutMs: 3_000 });
    const elapsed = Date.now() - started;
    assert.notEqual(res.exitCode, 0, 'a timed-out command must not report success');
    assert.ok(elapsed < 20_000, `the timeout should have fired promptly, took ${elapsed}ms`);
  });

  it('caps the number of processes a command can create', { skip: skip ?? false }, async () => {
    // A fork bomb under --pids-limit fails to spawn rather than taking the host
    // down. The assertion is simply that the sandbox returns and the daemon is
    // still answering afterwards.
    const res = await sandbox.exec(':(){ :|:& };: 2>&1; echo SURVIVED', { cwd: dir, timeoutMs: 20_000 });
    assert.ok(res.stdout.includes('SURVIVED') || res.exitCode !== 0, 'the sandbox must return either way');
    const after = await sandbox.exec('echo still-here', { cwd: dir, timeoutMs: 30_000 });
    assert.match(after.stdout, /still-here/, 'the daemon must still be usable after a fork bomb');
  });
});
