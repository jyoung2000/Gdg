import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MeridianError } from '@meridian/shared';

/**
 * Version control for workspaces.
 *
 * Plain git, executed argv-style with no shell, always inside a path the
 * caller was already authorized to reach. Meridian never stores GitHub
 * tokens for this: pushes and pulls use whatever credentials the operator's
 * environment already has (a credential helper, an SSH agent, a `gh` login),
 * and when there are none the honest answer is the git error, not a workaround.
 */

const OUTPUT_CAP = 120_000;

export interface GitRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
  staged: { path: string; state: string }[];
  unstaged: { path: string; state: string }[];
  untracked: string[];
  remoteUrl: string | null;
}

export interface GhInfo {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  detail: string | null;
}

export class GitService {
  private async run(cwd: string, args: string[], timeoutMs = 60_000, env?: Record<string, string>): Promise<GitRun> {
    return new Promise((resolvePromise) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${e.message}`.trim() });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr: timedOut ? `${stderr}\n[timed out]` : stderr });
      });
    });
  }

  private checkPath(path: string): string {
    const abs = resolve(path);
    if (!existsSync(abs)) throw new MeridianError('invalid_request', `${path} does not exist`);
    return abs;
  }

  async status(path: string): Promise<GitStatus> {
    const cwd = this.checkPath(path);
    const inside = await this.run(cwd, ['rev-parse', '--is-inside-work-tree'], 10_000);
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return { isRepo: false, branch: null, detached: false, ahead: 0, behind: 0, upstream: null, staged: [], unstaged: [], untracked: [], remoteUrl: null };
    }

    const [branchRun, statusRun, remoteRun] = await Promise.all([
      this.run(cwd, ['branch', '--show-current'], 10_000),
      this.run(cwd, ['status', '--porcelain=v1', '-b'], 20_000),
      this.run(cwd, ['remote', 'get-url', 'origin'], 10_000),
    ]);

    const branch = branchRun.stdout.trim() || null;
    const staged: GitStatus['staged'] = [];
    const unstaged: GitStatus['unstaged'] = [];
    const untracked: string[] = [];
    let ahead = 0;
    let behind = 0;
    let upstream: string | null = null;

    for (const line of statusRun.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('##')) {
        const m = /## [^.]+\.\.\.(\S+)(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(line);
        if (m) {
          upstream = m[1] ?? null;
          ahead = Number(m[2] ?? 0);
          behind = Number(m[3] ?? 0);
        }
        continue;
      }
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);
      if (x === '?' && y === '?') untracked.push(file);
      else {
        if (x !== ' ') staged.push({ path: file, state: x });
        if (y !== ' ') unstaged.push({ path: file, state: y });
      }
    }

    return {
      isRepo: true,
      branch,
      detached: branch === null,
      ahead,
      behind,
      upstream,
      staged: staged.slice(0, 200),
      unstaged: unstaged.slice(0, 200),
      untracked: untracked.slice(0, 200),
      remoteUrl: remoteRun.ok ? remoteRun.stdout.trim() : null,
    };
  }

  async branches(path: string): Promise<{ current: string | null; local: string[]; remote: string[] }> {
    const cwd = this.checkPath(path);
    const [local, remote, current] = await Promise.all([
      this.run(cwd, ['branch', '--format=%(refname:short)'], 15_000),
      this.run(cwd, ['branch', '-r', '--format=%(refname:short)'], 15_000),
      this.run(cwd, ['branch', '--show-current'], 10_000),
    ]);
    return {
      current: current.stdout.trim() || null,
      local: local.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200),
      remote: remote.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200),
    };
  }

  private validRef(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name) || name.includes('..')) {
      throw new MeridianError('invalid_request', `"${name}" is not a valid branch name`);
    }
    return name;
  }

  async createBranch(path: string, name: string, from?: string): Promise<GitRun> {
    const cwd = this.checkPath(path);
    const args = ['switch', '-c', this.validRef(name)];
    if (from) args.push(this.validRef(from));
    return this.run(cwd, args, 30_000);
  }

  async switchBranch(path: string, name: string): Promise<GitRun> {
    return this.run(this.checkPath(path), ['switch', this.validRef(name)], 30_000);
  }

  async commit(path: string, message: string, opts?: { addAll?: boolean }): Promise<GitRun> {
    const cwd = this.checkPath(path);
    if (!message.trim()) throw new MeridianError('invalid_request', 'A commit needs a message');
    if (opts?.addAll) {
      const add = await this.run(cwd, ['add', '-A'], 60_000);
      if (!add.ok) return add;
    }
    return this.run(cwd, ['commit', '-m', message.slice(0, 4000)], 60_000);
  }

  async fetch(path: string): Promise<GitRun> {
    return this.run(this.checkPath(path), ['fetch', '--prune'], 120_000);
  }

  async pull(path: string): Promise<GitRun> {
    return this.run(this.checkPath(path), ['pull', '--ff-only'], 120_000);
  }

  async push(path: string, opts?: { setUpstream?: boolean; branch?: string | null }): Promise<GitRun> {
    const cwd = this.checkPath(path);
    const args = ['push'];
    if (opts?.setUpstream) {
      const branch = opts.branch ?? (await this.run(cwd, ['branch', '--show-current'], 10_000)).stdout.trim();
      if (!branch) throw new MeridianError('invalid_request', 'No branch to push');
      args.push('-u', 'origin', this.validRef(branch));
    }
    return this.run(cwd, args, 180_000);
  }

  async log(path: string, limit = 30): Promise<{ hash: string; subject: string; author: string; at: string }[]> {
    const cwd = this.checkPath(path);
    const run = await this.run(cwd, ['log', `--max-count=${Math.min(limit, 100)}`, '--format=%h%x1f%s%x1f%an%x1f%cI'], 20_000);
    if (!run.ok) return [];
    return run.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, at] = line.split('\x1f');
        return { hash, subject: subject?.slice(0, 200) ?? '', author: author ?? '', at: at ?? '' };
      });
  }

  async diffSummary(path: string): Promise<string> {
    const cwd = this.checkPath(path);
    const run = await this.run(cwd, ['diff', '--stat', 'HEAD'], 30_000);
    return (run.stdout || run.stderr).slice(0, 20_000);
  }

  /* ---- GitHub CLI ------------------------------------------------- */

  private ghInfoCache: { at: number; info: GhInfo } | null = null;

  /** Honest detection: installed, and separately, actually authenticated. */
  async ghInfo(): Promise<GhInfo> {
    if (this.ghInfoCache && Date.now() - this.ghInfoCache.at < 60_000) return this.ghInfoCache.info;
    const version = await this.runGh(process.cwd(), ['--version'], 10_000);
    if (!version.ok) {
      const info = { installed: false, version: null, authenticated: false, detail: 'The gh CLI is not installed on the gateway host.' };
      this.ghInfoCache = { at: Date.now(), info };
      return info;
    }
    const auth = await this.runGh(process.cwd(), ['auth', 'status'], 15_000);
    const info: GhInfo = {
      installed: true,
      version: version.stdout.split('\n')[0]?.trim() ?? null,
      authenticated: auth.ok,
      detail: auth.ok ? null : 'gh is installed but not authenticated; run `gh auth login` on the gateway host.',
    };
    this.ghInfoCache = { at: Date.now(), info };
    return info;
  }

  /** Create a PR for the current branch via gh; only works when gh is ready. */
  async ghCreatePr(path: string, input: { title: string; body: string; base?: string; draft?: boolean }): Promise<GitRun> {
    const info = await this.ghInfo();
    if (!info.installed || !info.authenticated) {
      throw new MeridianError('unsupported_capability', info.detail ?? 'gh is not available');
    }
    const args = ['pr', 'create', '--title', input.title.slice(0, 300), '--body', input.body.slice(0, 20_000)];
    if (input.base) args.push('--base', this.validRef(input.base));
    if (input.draft) args.push('--draft');
    return this.runGh(this.checkPath(path), args, 60_000);
  }

  async ghListPrs(path: string): Promise<GitRun> {
    const info = await this.ghInfo();
    if (!info.installed || !info.authenticated) {
      throw new MeridianError('unsupported_capability', info.detail ?? 'gh is not available');
    }
    return this.runGh(this.checkPath(path), ['pr', 'list', '--limit', '30', '--json', 'number,title,state,headRefName,url'], 30_000);
  }

  private async runGh(cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
    return new Promise((resolvePromise) => {
      const child = spawn('gh', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += d.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolvePromise({ ok: false, exitCode: null, stdout, stderr: stderr || 'gh not found' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr });
      });
    });
  }
}
