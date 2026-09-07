import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { MeridianError } from '@meridian/shared';
import type {
  ClassifiedFailure,
  ContainerStatus,
  DockerAvailability,
  DockerOpResult,
  DockerProjectInfo,
  FailureClass,
} from './types.js';

const OUTPUT_CAP = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** meridian-test-<project>-<session>: unique, greppable, collision-free. */
export function isolationName(projectPath: string, sessionId: string): string {
  const slug = basename(resolve(projectPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const sess = sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
  return `meridian-test-${slug || 'app'}-${sess}`;
}

/** Map a failed stage + its output onto the failure taxonomy, honestly. */
export function classifyFailure(stage: ClassifiedFailure['stage'], output: string): ClassifiedFailure {
  const text = output.slice(-4_000);
  const pick = (cls: FailureClass, detail: string, retryable: boolean): ClassifiedFailure => ({ class: cls, stage, detail, retryable });

  if (/cannot connect to the docker daemon|docker daemon|is the docker daemon running|command not found.*docker|docker.*ENOENT/i.test(text)) {
    return pick('DOCKER_UNAVAILABLE', 'The Docker daemon is not reachable from the gateway.', false);
  }
  if (/(network|proxy|TLS|tls handshake|dial tcp|lookup .* on|EAI_AGAIN|i\/o timeout|403 Forbidden|blocked)/i.test(text) && /pull|fetch|download|registry|resolve/i.test(text)) {
    return pick('NETWORK_FAILURE', 'A registry or network fetch failed; check egress policy and configured registries.', true);
  }
  if (stage === 'build') return pick('BUILD_FAILURE', firstErrorLine(text) ?? 'The image build failed.', false);
  if (stage === 'up') return pick('STARTUP_FAILURE', firstErrorLine(text) ?? 'Containers failed to start.', true);
  if (stage === 'health') return pick('HEALTHCHECK_TIMEOUT', 'The service never reported healthy within the budget.', true);
  if (stage === 'test') return pick('TEST_FAILURE', firstErrorLine(text) ?? 'Tests failed inside the container.', false);
  if (stage === 'verify') return pick('VERIFY_FAILURE', firstErrorLine(text) ?? 'The browser verification step failed.', true);
  if (/timed? ?out/i.test(text)) return pick('TIMEOUT', 'The operation exceeded its time budget.', true);
  return pick('UNKNOWN', firstErrorLine(text) ?? 'Unclassified failure; see logs.', false);
}

function firstErrorLine(text: string): string | null {
  const line = text
    .split('\n')
    .reverse()
    .find((l) => /error|failed|fatal|panic|exception/i.test(l) && l.trim().length > 8);
  return line ? line.trim().slice(0, 300) : null;
}

export interface OrchestratorOptions {
  sessionId: string;
  onLog?: (line: string) => void;
  now?: () => number;
}

/**
 * Docker for development loops: detect a project's shape, build it, run it in
 * a session-isolated namespace, watch it, run things inside it, tear it down.
 * The docker CLI does the work — argv exec, no shell — and every created
 * resource is labeled meridian.session=<id>.
 */
export class DockerOrchestrator {
  readonly sessionId: string;
  private readonly onLog?: (line: string) => void;
  private readonly now: () => number;
  private availability: DockerAvailability | null = null;

  constructor(opts: OrchestratorOptions) {
    this.sessionId = opts.sessionId;
    this.onLog = opts.onLog;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Checked once, reported honestly; never assumed from configuration. */
  async detectDocker(): Promise<DockerAvailability> {
    if (this.availability) return this.availability;
    const version = await this.exec(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    if (!version.ok) {
      this.availability = {
        available: false,
        version: null,
        compose: false,
        detail: version.stderr.slice(0, 300) || 'docker CLI not available or daemon unreachable',
      };
      return this.availability;
    }
    const compose = await this.exec(['compose', 'version', '--short'], { timeoutMs: 15_000 });
    this.availability = {
      available: true,
      version: version.stdout.trim(),
      compose: compose.ok,
      detail: compose.ok ? null : 'docker compose plugin missing; compose projects unavailable',
    };
    return this.availability;
  }

  async detectProject(path: string): Promise<DockerProjectInfo> {
    const root = resolve(path);
    if (!existsSync(root)) throw new MeridianError('invalid_request', `${path} does not exist`);
    for (const candidate of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const file = join(root, candidate);
      if (!existsSync(file)) continue;
      const services = await this.composeServices(file, root);
      return { path: root, kind: 'compose', composeFile: file, dockerfile: null, services };
    }
    const dockerfile = join(root, 'Dockerfile');
    if (existsSync(dockerfile)) {
      return { path: root, kind: 'dockerfile', composeFile: null, dockerfile, services: [basename(root).toLowerCase()] };
    }
    return { path: root, kind: 'none', composeFile: null, dockerfile: null, services: [] };
  }

  private async composeServices(file: string, cwd: string): Promise<string[]> {
    const res = await this.exec(['compose', '-f', file, 'config', '--services'], { cwd, timeoutMs: 30_000 });
    if (res.ok) return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    // Fall back to a light parse rather than failing detection outright.
    try {
      const text = await readFile(file, 'utf8');
      const m = /^services:\s*$/m.exec(text);
      if (!m) return [];
      return Array.from(text.slice(m.index).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)).map((x) => x[1]);
    } catch {
      return [];
    }
  }

  projectName(path: string): string {
    return isolationName(path, this.sessionId);
  }

  async build(project: DockerProjectInfo, opts?: { timeoutMs?: number; buildArgs?: Record<string, string> }): Promise<DockerOpResult> {
    const name = this.projectName(project.path);
    const argFlags = Object.entries(opts?.buildArgs ?? {}).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
    if (project.kind === 'compose') {
      return this.exec(['compose', '-p', name, '-f', project.composeFile!, 'build', ...argFlags], {
        cwd: project.path,
        timeoutMs: opts?.timeoutMs ?? 900_000,
      });
    }
    if (project.kind === 'dockerfile') {
      return this.exec(
        ['build', '-t', `${name}:latest`, '--label', `meridian.session=${this.sessionId}`, ...argFlags, '-f', project.dockerfile!, project.path],
        { cwd: project.path, timeoutMs: opts?.timeoutMs ?? 900_000 },
      );
    }
    throw new MeridianError('invalid_request', 'No Dockerfile or compose file to build');
  }

  async up(project: DockerProjectInfo, opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<DockerOpResult> {
    const name = this.projectName(project.path);
    if (project.kind === 'compose') {
      return this.exec(['compose', '-p', name, '-f', project.composeFile!, 'up', '-d', '--no-build'], {
        cwd: project.path,
        timeoutMs: opts?.timeoutMs ?? 180_000,
        env: opts?.env,
      });
    }
    if (project.kind === 'dockerfile') {
      const envFlags = Object.entries(opts?.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return this.exec(
        ['run', '-d', '--name', name, '--label', `meridian.session=${this.sessionId}`, '-P', ...envFlags, `${name}:latest`],
        { timeoutMs: opts?.timeoutMs ?? 120_000 },
      );
    }
    throw new MeridianError('invalid_request', 'Nothing to start');
  }

  async down(project: DockerProjectInfo): Promise<DockerOpResult> {
    const name = this.projectName(project.path);
    if (project.kind === 'compose') {
      return this.exec(['compose', '-p', name, '-f', project.composeFile!, 'down', '-v', '--remove-orphans'], {
        cwd: project.path,
        timeoutMs: 120_000,
      });
    }
    const rm = await this.exec(['rm', '-f', name], { timeoutMs: 60_000 });
    await this.exec(['rmi', '-f', `${name}:latest`], { timeoutMs: 60_000 });
    return rm;
  }

  async ps(project: DockerProjectInfo): Promise<ContainerStatus[]> {
    const name = this.projectName(project.path);
    const filter = project.kind === 'compose' ? `label=com.docker.compose.project=${name}` : `name=^/${name}$`;
    const res = await this.exec(
      ['ps', '-a', '--filter', filter, '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'],
      { timeoutMs: 30_000 },
    );
    if (!res.ok) return [];
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, cname, image, state, status, ports] = line.split('\t');
        return { id, name: cname, image, state, status: status ?? '', ports: ports ?? '' };
      });
  }

  async logs(project: DockerProjectInfo, opts?: { service?: string; tail?: number }): Promise<string> {
    const name = this.projectName(project.path);
    const tail = String(Math.min(opts?.tail ?? 200, 2000));
    const res =
      project.kind === 'compose'
        ? await this.exec(
            ['compose', '-p', name, '-f', project.composeFile!, 'logs', '--no-color', '--tail', tail, ...(opts?.service ? [opts.service] : [])],
            { cwd: project.path, timeoutMs: 30_000 },
          )
        : await this.exec(['logs', '--tail', tail, name], { timeoutMs: 30_000 });
    return `${res.stdout}\n${res.stderr}`.trim();
  }

  async execIn(project: DockerProjectInfo, command: string[], opts?: { service?: string; timeoutMs?: number }): Promise<DockerOpResult> {
    const name = this.projectName(project.path);
    if (project.kind === 'compose') {
      const service = opts?.service ?? project.services[0];
      if (!service) throw new MeridianError('invalid_request', 'No service to exec into');
      return this.exec(['compose', '-p', name, '-f', project.composeFile!, 'exec', '-T', service, ...command], {
        cwd: project.path,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    }
    return this.exec(['exec', name, ...command], { timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  /**
   * Wait until every container reports running (and healthy, when a
   * healthcheck exists). Never spins forever; the budget decides.
   */
  async waitHealthy(project: DockerProjectInfo, budgetMs = 120_000): Promise<{ ok: boolean; detail: string }> {
    const deadline = this.now() + budgetMs;
    let last = 'no containers found';
    while (this.now() < deadline) {
      const containers = await this.ps(project);
      if (containers.length > 0) {
        const bad = containers.filter((c) => c.state !== 'running' || /unhealthy|restarting/i.test(c.status));
        const starting = containers.filter((c) => /health: starting/i.test(c.status));
        if (bad.length === 0 && starting.length === 0) return { ok: true, detail: `${containers.length} container(s) running` };
        last = bad.concat(starting).map((c) => `${c.name}: ${c.state} (${c.status})`).join('; ');
        const dead = containers.filter((c) => c.state === 'exited' || c.state === 'dead');
        if (dead.length > 0) return { ok: false, detail: last };
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return { ok: false, detail: `not healthy within ${Math.round(budgetMs / 1000)}s: ${last}` };
  }

  /** Remove everything this session ever created, and nothing else. */
  async cleanupSession(): Promise<void> {
    const res = await this.exec(['ps', '-aq', '--filter', `label=meridian.session=${this.sessionId}`], { timeoutMs: 30_000 });
    const ids = res.stdout.split('\n').filter(Boolean);
    if (ids.length > 0) await this.exec(['rm', '-f', ...ids], { timeoutMs: 60_000 });
  }

  // ---- process plumbing ----------------------------------------------------

  async exec(args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<DockerOpResult> {
    const started = this.now();
    const command = `docker ${args.join(' ')}`.slice(0, 400);
    this.onLog?.(`$ ${command}`);
    return new Promise((resolvePromise) => {
      const child = spawn('docker', args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const budget = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, budget);
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${e.message}`, durationMs: this.now() - started, command });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) stderr += `\n[timed out after ${budget}ms]`;
        resolvePromise({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr, durationMs: this.now() - started, command });
      });
    });
  }
}
