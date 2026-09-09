import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * The gateway as a desktop application's backend.
 *
 * Everything here runs the real entry point as a real child process, because
 * that is the only way any of it can be true. A desktop shell starts the
 * gateway, has to learn which port it actually got, has to be able to stop it on
 * an operating system with no SIGTERM, and must not leave it running when the
 * shell itself dies. None of those are properties of a function; they are
 * properties of a process.
 *
 * This runs on Linux in CI and exercises the same code Windows will run. The
 * one thing it cannot prove is the Windows process semantics themselves, which
 * is what the Windows smoke job in CI is for.
 */

const REPO = resolve(import.meta.dirname, '..', '..');
const ENTRY = resolve(REPO, 'apps/gateway/src/main.ts');
const READY_PREFIX = 'meridian-ready ';

interface Launched {
  child: ChildProcessWithoutNullStreams;
  /** The announce line, parsed. */
  state: { pid: number; port: number; url: string; desktop: boolean; host: string };
  stdout: string;
  stderr: string;
}

describe('Gateway lifecycle under a desktop shell', () => {
  let dataDir: string;
  let sim: SimServer;
  const running: ChildProcessWithoutNullStreams[] = [];

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-desktop-'));
    // A local inference server so discovery has something real to find and the
    // readiness check passes for the right reason rather than by luck.
    sim = await startSimServer();
  });

  after(async () => {
    for (const child of running) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await sim?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Start the real gateway the way the desktop shell starts it. */
  function launch(extraEnv: NodeJS.ProcessEnv = {}, workdir = dataDir): Promise<Launched> {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        MERIDIAN_DESKTOP: '1',
        MERIDIAN_DATA_DIR: workdir,
        MERIDIAN_DB: join(workdir, 'meridian.db'),
        MERIDIAN_WORKSPACE_ROOT: join(workdir, 'workspaces'),
        MERIDIAN_ASSET_ROOT: join(workdir, 'assets'),
        MERIDIAN_RUNTIME_STATE: join(workdir, 'runtime', 'instance.json'),
        MERIDIAN_MASTER_KEY: 'desktop-lifecycle-test-key',
        MERIDIAN_LOG_LEVEL: 'error',
        MERIDIAN_HEALTH_INTERVAL_MS: '0',
        MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
        MERIDIAN_SANDBOX: 'process',
        MERIDIAN_LOCAL_ENDPOINTS: sim.root,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    running.push(child);

    return new Promise((resolvePromise, reject) => {
      let stdout = '';
      let stderr = '';
      const deadline = setTimeout(() => reject(new Error(`no ready line within 60s.\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 60_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const line = stdout.split('\n').find((l) => l.startsWith(READY_PREFIX));
        if (!line) return;
        clearTimeout(deadline);
        resolvePromise({ child, state: JSON.parse(line.slice(READY_PREFIX.length)), stdout, stderr });
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('exit', (code) => {
        clearTimeout(deadline);
        reject(new Error(`the gateway exited with ${code} before announcing.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });
  }

  const exited = (child: ChildProcessWithoutNullStreams, ms: number): Promise<number | null> =>
    new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), ms);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolvePromise(code ?? 0);
      });
    });

  it('announces the port it actually bound, on stdout, in one parseable line', async () => {
    const { child, state } = await launch({ PORT: '0' });
    try {
      // PORT=0 means the OS chose. A shell that assumed the number it asked
      // for would be pointing a window at nothing.
      assert.ok(state.port > 0 && state.port < 65536, `expected a real port, got ${state.port}`);
      assert.equal(state.desktop, true);
      assert.equal(state.host, '127.0.0.1', 'a desktop backend binds loopback, not every interface');
      assert.equal(state.url, `http://127.0.0.1:${state.port}`);
      assert.equal(state.pid, child.pid);

      // And the port it announced is the port it is serving on.
      const res = await fetch(`${state.url}/api/system/ready`);
      assert.equal(res.status, 200, 'the announced address must be the one that answers');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('binds loopback only, so installing a desktop app does not publish a server', async () => {
    const { child, state } = await launch({ PORT: '0' });
    try {
      // The loopback address answers.
      assert.equal((await fetch(`${state.url}/api/system/health`)).status, 200);

      // A non-loopback local address does not. Connecting to a port bound only
      // to 127.0.0.1 from another local interface is refused by the kernel,
      // which is the property that matters: nobody else on the user's network
      // can reach their models, keys or workspaces.
      const reachable = await fetch(`http://127.0.0.2:${state.port}/api/system/health`, {
        signal: AbortSignal.timeout(2000),
      })
        .then(() => true)
        .catch(() => false);
      assert.equal(reachable, false, 'the gateway answered on an address it was never asked to bind');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('moves off the preferred port when something else already holds it', async () => {
    // Exactly the shape a desktop install meets: the user has had something on
    // this port for years and has no idea what it is.
    const squatter: Server = createServer();
    const preferred = await new Promise<number>((resolvePromise) => {
      squatter.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
        const addr = squatter.address();
        resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const { child, state } = await launch({ PORT: String(preferred) });
      try {
        assert.notEqual(state.port, preferred, 'the gateway must not claim a port another process is holding');
        assert.ok(state.port > 0);
        assert.equal((await fetch(`${state.url}/api/system/ready`)).status, 200, 'and must actually serve on the one it moved to');
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      squatter.close();
    }
  });

  it('refuses to move for a server operator, who needs to see the collision', async () => {
    // A container that quietly moves to a different port is a container whose
    // published port maps to nothing. The operator has to be told.
    const squatter: Server = createServer();
    const preferred = await new Promise<number>((resolvePromise) => {
      squatter.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
        const addr = squatter.address();
        resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
        cwd: REPO,
        env: {
          ...process.env,
          // No MERIDIAN_DESKTOP, and no opt-in to fallback.
          MERIDIAN_DATA_DIR: dataDir,
          MERIDIAN_DB: join(dataDir, 'strict.db'),
          MERIDIAN_HOST: '127.0.0.1',
          PORT: String(preferred),
          MERIDIAN_MASTER_KEY: 'desktop-lifecycle-test-key',
          MERIDIAN_LOG_LEVEL: 'error',
          MERIDIAN_HEALTH_INTERVAL_MS: '0',
          MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
          MERIDIAN_SANDBOX: 'process',
          MERIDIAN_LOCAL_ENDPOINTS: sim.root,
          MERIDIAN_RUNTIME_STATE: join(dataDir, 'runtime', 'strict.json'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      running.push(child);

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => {
        stderr += c;
      });
      const code = await exited(child, 60_000);
      assert.notEqual(code, null, 'the gateway should have exited rather than hung');
      assert.notEqual(code, 0, 'a port collision must be a failure, not a silent relocation');
      assert.match(stderr, /EADDRINUSE|address already in use/i);
    } finally {
      squatter.close();
    }
  });

  it('shuts down cleanly when asked over stdin, which is the only way on Windows', async () => {
    const { child, state } = await launch({ PORT: '0' });

    // Windows has no SIGTERM. A parent that wants a child gone calls
    // TerminateProcess, which is kill -9 with no handler and no chance to close
    // the database. This is the polite ask, and it works everywhere.
    child.stdin.write('shutdown\n');

    const code = await exited(child, 30_000);
    assert.equal(code, 0, 'a requested shutdown is a clean exit, not a crash');

    // It really stopped serving, rather than merely exiting the parent's view.
    const stillUp = await fetch(`${state.url}/api/system/health`, { signal: AbortSignal.timeout(2000) })
      .then(() => true)
      .catch(() => false);
    assert.equal(stillUp, false);
  });

  it('shuts down when its parent disappears, so a crashed shell leaves nothing behind', async () => {
    const { child, state } = await launch({ PORT: '0' });

    // Closing stdin is what a dead parent looks like from in here. Without this
    // the gateway would survive as an invisible process still holding the
    // database and the port, and the next launch would find both taken by
    // something the user cannot see or stop.
    child.stdin.end();

    const code = await exited(child, 30_000);
    assert.equal(code, 0);
    const stillUp = await fetch(`${state.url}/api/system/health`, { signal: AbortSignal.timeout(2000) })
      .then(() => true)
      .catch(() => false);
    assert.equal(stillUp, false, 'an orphaned gateway is a process the user cannot find to kill');
  });

  it('publishes where it is listening, and tidies up after itself', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'meridian-discovery-'));
    const statePath = join(workdir, 'runtime', 'instance.json');
    try {
      const { child, state } = await launch({ PORT: '0', MERIDIAN_RUNTIME_STATE: statePath }, workdir);

      assert.ok(existsSync(statePath), 'a running instance must leave a note saying where it is');
      const published = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      assert.equal(published.port, state.port);
      assert.equal(published.pid, child.pid);
      assert.equal(published.url, state.url);

      // Nothing in the note may be a secret. It sits at a predictable path with
      // no access control worth the name, so what it carries is a constraint,
      // not an accident of what happens to be in it today.
      const text = readFileSync(statePath, 'utf8');
      assert.ok(!/key|secret|token|password/i.test(text), `the discovery file must carry no credentials:\n${text}`);

      child.stdin.write('shutdown\n');
      await exited(child, 30_000);
      assert.equal(existsSync(statePath), false, 'and must remove it on the way out, or the next reader is misled');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
