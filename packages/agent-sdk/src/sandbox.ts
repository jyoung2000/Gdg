import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { MeridianError, type Logger } from '@meridian/shared';

export interface ExecOptions {
  /** Working directory on the host. Mounted into the container in docker mode. */
  cwd: string;
  timeoutMs?: number;
  /** Extra environment for the command. Never inherits the gateway's own env. */
  env?: Record<string, string>;
  /** Bytes of combined stdout+stderr to keep. Output beyond this is truncated. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface Sandbox {
  readonly kind: 'docker' | 'process' | 'disabled';
  /** Honest description of what this sandbox does and does not isolate. */
  readonly isolationNote: string;
  /**
   * One line, complete on its own, leading with whatever the reader most needs
   * to know.
   *
   * The long note gets truncated wherever space is tight, and truncation drops
   * the end of a sentence — which for the process sandbox is exactly the clause
   * that says it is not a security boundary. A summary that is already short
   * cannot lose its warning that way.
   */
  readonly isolationSummary: string;
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  available(): Promise<boolean>;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/**
 * A minimal, explicitly-constructed environment.
 *
 * The gateway's own process environment holds every provider credential the
 * operator configured. Passing it to a model-authored command would hand those
 * credentials to the model, so the sandbox builds its environment from scratch
 * instead of filtering the existing one — a denylist would leak whatever it
 * failed to anticipate.
 */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NODE_OPTIONS: '--max-old-space-size=1024',
    ...extra,
  };
}

/**
 * Docker-backed isolation: a throwaway container per command with no network,
 * a read-only root filesystem apart from the mounted workspace, dropped
 * capabilities, a pid ceiling and hard memory and CPU limits. This is the
 * strong option and the default in the shipped Compose stack.
 */
export interface DockerSandboxOptions {
  image: string;
  memoryMb: number;
  cpus: number;
  network: boolean;
  logger: Logger;
  /**
   * Where the workspace root lives *on the Docker host*, when the gateway is
   * itself in a container.
   *
   * `docker run -v <path>:/work` is resolved by the daemon against the host
   * filesystem, not against the caller's. A containerised gateway asking for
   * `-v /workspaces/ws_x:/work` therefore mounts a host path that usually does
   * not exist — Docker creates it, empty, and the command runs against nothing
   * while appearing to succeed. Pairing this with {@link workspaceRoot} lets
   * the sandbox translate its own path into the host's.
   */
  hostWorkspaceRoot?: string | null;
  /** The workspace root as this process sees it. Required with hostWorkspaceRoot. */
  workspaceRoot?: string | null;
}

export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly isolationNote =
    'Each command runs in a throwaway container with no network, a read-only root filesystem, dropped capabilities, and hard memory, CPU and process limits. Only the workspace directory is writable.';
  readonly isolationSummary = 'Isolated: a throwaway container with no network and no writable path but the workspace.';

  private readonly image: string;
  private readonly memoryMb: number;
  private readonly cpus: number;
  private readonly network: boolean;
  private readonly logger: Logger;
  private readonly hostWorkspaceRoot: string | null;
  private readonly workspaceRoot: string | null;

  constructor(opts: DockerSandboxOptions) {
    this.image = opts.image;
    this.memoryMb = opts.memoryMb;
    this.cpus = opts.cpus;
    this.network = opts.network;
    this.logger = opts.logger;
    this.hostWorkspaceRoot = opts.hostWorkspaceRoot ? resolve(opts.hostWorkspaceRoot) : null;
    this.workspaceRoot = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;
  }

  /**
   * The path the Docker daemon should mount for a directory this process sees
   * at `cwd`.
   *
   * Without a configured host root the two are the same, which is correct
   * whenever the gateway runs directly on the Docker host.
   */
  hostPathFor(cwd: string): string {
    if (!this.hostWorkspaceRoot || !this.workspaceRoot) return resolve(cwd);
    const abs = resolve(cwd);
    const rel = relative(this.workspaceRoot, abs);
    // Outside the workspace root: nothing sensible to translate to, so pass it
    // through rather than inventing a host path.
    if (rel.startsWith('..') || rel.startsWith(sep)) return abs;
    return rel ? join(this.hostWorkspaceRoot, rel) : this.hostWorkspaceRoot;
  }

  /**
   * Run the sandboxed command as the same user as the gateway.
   *
   * The image ships a non-root user, but its uid is not the gateway's, so a
   * command could read the workspace and never write to it. Matching the
   * caller's uid gives the sandbox exactly the access the gateway already has
   * and no more — the container has no network, no capabilities, a read-only
   * root and nothing mounted but the workspace, so the uid is not what is
   * holding it in.
   */
  private userFlag(): string[] {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];
    return ['--user', `${process.getuid()}:${process.getgid()}`];
  }

  async available(): Promise<boolean> {
    return (await this.diagnose()) === null;
  }

  /**
   * Why this sandbox cannot be used, or null when it can.
   *
   * A reachable daemon is not enough: without the image, every command fails at
   * run time with a registry error the operator has no reason to connect to
   * their sandbox setting. Checking it here turns that into one accurate
   * sentence at startup.
   */
  async diagnose(): Promise<string | null> {
    const version = await runProcess('docker', ['version', '--format', '{{.Server.Version}}'], {
      cwd: process.cwd(),
      timeoutMs: 8000,
      env: baseEnv(),
      maxOutputBytes: 4096,
    });
    if (version.exitCode !== 0) {
      return 'Docker is not reachable from the gateway';
    }

    const image = await runProcess('docker', ['image', 'inspect', this.image, '--format', '{{.Id}}'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: baseEnv(),
      maxOutputBytes: 4096,
    });
    if (image.exitCode !== 0) {
      return `The sandbox image "${this.image}" is not present — build it with \`docker build -f docker/Dockerfile.sandbox -t ${this.image} .\``;
    }

    return this.probeMount();
  }

  /**
   * Check that a mounted workspace really reaches the same files, both ways.
   *
   * Two misconfigurations are otherwise silent and destructive. If the gateway
   * runs in a container, the path it passes to `-v` is resolved against the
   * host, so the daemon mounts an empty directory it just created and every
   * command runs against nothing while reporting success. And if the container
   * user cannot write the mount, every command that builds, installs or commits
   * fails with a permission error the operator has no reason to connect to
   * their sandbox setting.
   *
   * A read and a write through a real container is the only check that catches
   * both, so it runs once at startup rather than being reasoned about.
   */
  private async probeMount(): Promise<string | null> {
    if (!this.workspaceRoot) return null;

    let dir: string;
    try {
      // The probe can run before the gateway has created the root, so create it
      // here rather than reporting a missing directory as a permission problem.
      mkdirSync(this.workspaceRoot, { recursive: true });
      dir = mkdtempSync(join(this.workspaceRoot, '.sandbox-probe-'));
    } catch (e) {
      return `The workspace root ${this.workspaceRoot} is not writable by the gateway (${e instanceof Error ? e.message : String(e)})`;
    }

    const token = `meridian-probe-${Date.now().toString(36)}`;
    try {
      writeFileSync(join(dir, 'from-gateway'), token, 'utf8');

      const res = await runProcess(
        'docker',
        [
          'run', '--rm', '-i',
          '--network', 'none',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          '--read-only',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
          ...this.userFlag(),
          '-v', `${this.hostPathFor(dir)}:/work`,
          '-w', '/work',
          this.image,
          'sh', '-lc', 'cat from-gateway 2>/dev/null; echo; printf %s "$0" > from-container 2>/dev/null || echo NOWRITE', token,
        ],
        { cwd: process.cwd(), timeoutMs: 60_000, env: baseEnv(), maxOutputBytes: 8192 },
      );

      if (res.exitCode !== 0) {
        return `A probe container could not run (${(res.stderr || res.stdout).trim().slice(0, 300)})`;
      }
      if (!res.stdout.includes(token)) {
        return this.hostWorkspaceRoot
          ? `The sandbox mounted ${this.hostPathFor(dir)} but did not see the workspace's files, so MERIDIAN_WORKSPACE_HOST_ROOT does not match where ${this.workspaceRoot} actually lives on the Docker host`
          : `The sandbox mounted ${dir} but did not see the workspace's files. This gateway appears to be running inside a container, where that path means something different to the Docker daemon — set MERIDIAN_WORKSPACE_HOST_ROOT to the host directory that ${this.workspaceRoot} is mounted from`;
      }

      let wroteBack = '';
      try {
        wroteBack = readFileSync(join(dir, 'from-container'), 'utf8');
      } catch {
        wroteBack = '';
      }
      if (wroteBack !== token) {
        return `The sandbox can read the workspace but not write to it, so any command that builds, installs or commits would fail. Check the ownership of ${this.workspaceRoot}`;
      }
      return null;
    } catch (e) {
      return `The sandbox mount probe failed (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const args = [
      'run',
      '--rm',
      '-i',
      '--network', this.network ? 'bridge' : 'none',
      '--memory', `${this.memoryMb}m`,
      // Without a swap limit equal to the memory limit, a container can evade
      // the memory cap entirely by swapping.
      '--memory-swap', `${this.memoryMb}m`,
      '--cpus', String(this.cpus),
      '--pids-limit', '256',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      // Writable scratch that vanishes with the container.
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      ...this.userFlag(),
      '-v', `${this.hostPathFor(opts.cwd)}:/work`,
      '-w', '/work',
    ];
    for (const [k, v] of Object.entries(baseEnv(opts.env))) args.push('-e', `${k}=${v}`);
    args.push(this.image, 'sh', '-lc', command);

    this.logger.debug('sandbox exec', { sandbox: 'docker', cwd: opts.cwd });
    return runProcess('docker', args, { ...opts, env: baseEnv(), timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT });
  }
}

/**
 * Process-backed isolation: the command runs as a child process of the gateway,
 * with a clean environment, the workspace as its working directory, a wall-clock
 * timeout, an output cap and process-group kill on timeout.
 *
 * This is a real reduction in blast radius but it is NOT a security boundary:
 * the command shares the host filesystem and network and runs as the gateway's
 * own user. It exists so the product works on a machine without Docker, and the
 * UI says so plainly wherever a sandboxed command can be started. Use the docker
 * sandbox for anything you would not run yourself.
 */
export class ProcessSandbox implements Sandbox {
  readonly kind = 'process' as const;
  readonly isolationNote =
    'Commands run as child processes of the gateway with a clean environment, a wall-clock timeout, an output cap, and the workspace as the working directory. This limits accidents; it is not a security boundary — the command can reach the host filesystem and network. Use the Docker sandbox for untrusted work.';
  readonly isolationSummary = 'Not a security boundary: a command can reach the host filesystem and network.';

  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    this.logger.debug('sandbox exec', { sandbox: 'process', cwd: opts.cwd });
    return runProcess('/bin/sh', ['-lc', command], {
      ...opts,
      env: baseEnv(opts.env),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    });
  }
}

/** Refuses every command. Chosen when the operator wants no execution at all. */
export class DisabledSandbox implements Sandbox {
  readonly kind = 'disabled' as const;
  readonly isolationNote = 'Command execution is disabled on this instance.';
  readonly isolationSummary = 'Off: agents cannot run commands on this instance.';

  async available(): Promise<boolean> {
    return false;
  }

  async exec(): Promise<ExecResult> {
    throw new MeridianError('invalid_request', 'Command execution is disabled on this instance');
  }
}

export function createSandbox(
  kind: 'docker' | 'process' | 'disabled',
  opts: DockerSandboxOptions,
): Sandbox {
  switch (kind) {
    case 'docker':
      return new DockerSandbox(opts);
    case 'disabled':
      return new DisabledSandbox();
    default:
      return new ProcessSandbox(opts.logger);
  }
}

/**
 * Choose the strongest sandbox that actually works here, and say which one was
 * chosen. Falling back silently from docker to process would misrepresent the
 * isolation the operator asked for.
 */
export async function resolveSandbox(
  preferred: 'docker' | 'process' | 'disabled',
  opts: DockerSandboxOptions,
): Promise<{ sandbox: Sandbox; degraded: boolean; reason: string | null }> {
  const chosen = createSandbox(preferred, opts);
  if (preferred === 'docker') {
    const detail = await (chosen as DockerSandbox).diagnose();
    if (detail === null) return { sandbox: chosen, degraded: false, reason: null };
    const fallback = new ProcessSandbox(opts.logger);
    const reason = `${detail.replace(/\.$/, '')}. Command execution fell back to the process sandbox, which is not a security boundary.`;
    opts.logger.warn('sandbox degraded', { requested: 'docker', using: 'process', detail });
    return { sandbox: fallback, degraded: true, reason };
  }
  if (await chosen.available()) return { sandbox: chosen, degraded: false, reason: null };
  return { sandbox: chosen, degraded: false, reason: null };
}

/* ------------------------------------------------------------------ */

function runProcess(
  file: string,
  args: string[],
  opts: ExecOptions & { env: Record<string, string> },
): Promise<ExecResult> {
  const started = Date.now();
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      // Its own process group, so a timeout kills the whole tree rather than
      // leaving orphaned grandchildren holding the workspace open.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - bytes;
      const text = chunk.subarray(0, room).toString('utf8');
      bytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
      if (into === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // A process that ignores SIGTERM still has to go.
      setTimeout(() => killTree('SIGKILL'), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      killTree('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, truncated, durationMs: Date.now() - started });
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new MeridianError('internal', `Failed to start command: ${e.message}`, { cause: e }));
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 124 : 1)));
  });
}
