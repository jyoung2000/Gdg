import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { MeridianError, newId, type FileChange, type FileNode } from '@meridian/shared';

/** Directories never walked, listed or searched. Noise, and often enormous. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.turbo',
  'coverage', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.pnpm-store', '.gradle',
  '.idea', '.vscode', 'tmp', '.DS_Store',
]);

/** Extensions treated as binary: never read into a model's context. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.avi', '.webm', '.mkv',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.pdf', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.so', '.dylib', '.dll', '.exe', '.bin', '.wasm', '.class',
  '.jar', '.pyc', '.o', '.a', '.node', '.db', '.sqlite', '.sqlite3',
]);

const MAX_READ_BYTES = 512 * 1024;

/**
 * Largest file a checkpoint will copy.
 *
 * A checkpoint that quietly skipped a big file would rewind to a state that
 * never existed, so anything over the limit is recorded as skipped and the
 * rewind reports it rather than pretending the file was restored.
 */
const MAX_CHECKPOINT_BYTES = 1024 * 1024;

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  at: number;
  /** Content of every touched file at snapshot time; null means it did not exist. */
  files: { path: string; content: string | null }[];
  /** Files too large to copy. A rewind leaves these alone and says so. */
  skipped: string[];
  /** The review state as it stood, so a rewind restores that too. */
  changes: FileChange[];
}

/**
 * A workspace on disk, with every path operation confined to its root.
 *
 * Path containment is enforced in one place — {@link Workspace.absolute} — and
 * every other method goes through it. A model can and will produce paths with
 * `..` in them; a check scattered across call sites is a check that eventually
 * gets missed.
 */
export class Workspace {
  readonly root: string;
  private readonly changes = new Map<string, FileChange>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  static async create(root: string): Promise<Workspace> {
    await mkdir(resolve(root), { recursive: true });
    return new Workspace(root);
  }

  /** Resolve a workspace-relative path, refusing anything outside the root. */
  absolute(relPath: string): string {
    const cleaned = relPath.replace(/^[/\\]+/, '');
    const abs = resolve(this.root, cleaned);
    // Compare with a trailing separator so `/work-other` cannot pass as `/work`.
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new MeridianError('invalid_request', `Path "${relPath}" is outside the workspace`);
    }
    return abs;
  }

  relative(absPath: string): string {
    return relative(this.root, absPath).split(sep).join('/');
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await access(this.absolute(relPath), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Read a text file. Refuses binaries and anything oversized. */
  async read(relPath: string): Promise<string> {
    const abs = this.absolute(relPath);
    if (isBinaryPath(relPath)) {
      throw new MeridianError('invalid_request', `${relPath} is a binary file and cannot be read as text`);
    }
    const info = await stat(abs).catch(() => null);
    if (!info) throw new MeridianError('invalid_request', `${relPath} does not exist`);
    if (info.isDirectory()) throw new MeridianError('invalid_request', `${relPath} is a directory`);
    if (info.size > MAX_READ_BYTES) {
      throw new MeridianError('invalid_request', `${relPath} is ${Math.round(info.size / 1024)}KB, larger than the ${MAX_READ_BYTES / 1024}KB read limit`);
    }
    const buf = await readFile(abs);
    // A NUL byte in the first 8KB is the reliable signal that a file without a
    // known binary extension is binary anyway.
    if (buf.subarray(0, 8192).includes(0)) {
      throw new MeridianError('invalid_request', `${relPath} appears to be binary`);
    }
    return buf.toString('utf8');
  }

  /**
   * Write a file, recording what was there before.
   *
   * The original content is captured on the first write to a path, so a whole
   * task's changes can be reverted afterwards. This is what makes Reject and
   * Undo real rather than advisory.
   */
  async write(relPath: string, content: string): Promise<FileChange> {
    const abs = this.absolute(relPath);
    const existing = this.changes.get(relPath);
    const before = existing ? existing.before : await this.read(relPath).catch(() => null);

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');

    const change: FileChange = {
      path: relPath,
      kind: before === null ? 'added' : 'modified',
      before,
      after: content,
      ...countDiff(before ?? '', content),
      state: 'pending',
    };
    this.changes.set(relPath, change);
    return change;
  }

  /**
   * Replace an exact string. Requires a unique match: a model that supplies an
   * ambiguous anchor is guessing, and applying the first match would silently
   * edit the wrong place.
   */
  async edit(relPath: string, oldText: string, newText: string, replaceAll = false): Promise<FileChange> {
    const current = await this.read(relPath);
    if (!oldText) throw new MeridianError('invalid_request', 'The text to replace must not be empty');
    const occurrences = countOccurrences(current, oldText);
    if (occurrences === 0) {
      throw new MeridianError('invalid_request', `The text to replace was not found in ${relPath}`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new MeridianError('invalid_request', `The text to replace appears ${occurrences} times in ${relPath}. Include more surrounding context, or set replace_all.`);
    }
    const next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    return this.write(relPath, next);
  }

  async delete(relPath: string): Promise<FileChange> {
    const abs = this.absolute(relPath);
    const before = await this.read(relPath).catch(() => null);
    if (before === null) throw new MeridianError('invalid_request', `${relPath} does not exist`);
    await rm(abs, { force: true });
    const change: FileChange = {
      path: relPath,
      kind: 'deleted',
      before,
      after: null,
      additions: 0,
      deletions: before.split('\n').length,
      state: 'pending',
    };
    this.changes.set(relPath, change);
    return change;
  }

  /** The file tree, pruned of ignored directories and bounded in depth. */
  async tree(relPath = '', maxDepth = 6): Promise<FileNode> {
    const abs = this.absolute(relPath);
    const name = relPath === '' ? (this.root.split(sep).pop() ?? 'workspace') : (relPath.split('/').pop() ?? relPath);

    const walk = async (dir: string, depth: number): Promise<FileNode[]> => {
      if (depth > maxDepth) return [];
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const nodes: FileNode[] = [];
      for (const e of entries.sort(byDirThenName)) {
        if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example') continue;
        if (IGNORED_DIRS.has(e.name)) continue;
        const childAbs = join(dir, e.name);
        const rel = this.relative(childAbs);
        if (e.isDirectory()) {
          nodes.push({ path: rel, name: e.name, type: 'directory', size: null, children: await walk(childAbs, depth + 1) });
        } else if (e.isFile()) {
          const info = await stat(childAbs).catch(() => null);
          nodes.push({ path: rel, name: e.name, type: 'file', size: info?.size ?? null });
        }
      }
      return nodes;
    };

    return { path: relPath, name, type: 'directory', size: null, children: await walk(abs, 0) };
  }

  /** Flat list of every non-ignored file path, for search and glob. */
  async listFiles(limit = 20_000): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= limit) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (out.length >= limit) return;
        if (IGNORED_DIRS.has(e.name)) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push(this.relative(abs));
      }
    };
    await walk(this.root);
    return out.sort();
  }

  /** Glob with `*`, `**` and `?`. Small enough to own rather than depend on. */
  async glob(pattern: string, limit = 500): Promise<string[]> {
    const re = globToRegExp(pattern);
    const files = await this.listFiles();
    return files.filter((f) => re.test(f)).slice(0, limit);
  }

  /** Content search. Returns matching lines with their line numbers. */
  async grep(
    pattern: string,
    opts: { glob?: string; caseInsensitive?: boolean; maxResults?: number; contextLines?: number } = {},
  ): Promise<{ path: string; line: number; text: string; context?: string[] }[]> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
    } catch (e) {
      throw new MeridianError('invalid_request', `Invalid search pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    const candidates = opts.glob ? await this.glob(opts.glob, 5000) : await this.listFiles();
    const results: { path: string; line: number; text: string; context?: string[] }[] = [];
    const max = opts.maxResults ?? 200;

    for (const path of candidates) {
      if (results.length >= max) break;
      if (isBinaryPath(path)) continue;
      const content = await this.read(path).catch(() => null);
      if (content === null) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < max; i++) {
        if (!re.test(lines[i])) continue;
        const hit: { path: string; line: number; text: string; context?: string[] } = {
          path,
          line: i + 1,
          text: lines[i].slice(0, 400),
        };
        if (opts.contextLines) {
          hit.context = lines.slice(Math.max(0, i - opts.contextLines), i + opts.contextLines + 1).map((l) => l.slice(0, 400));
        }
        results.push(hit);
      }
    }
    return results;
  }

  /* ---------------------------------------------------------------- */
  /* Change review                                                    */
  /* ---------------------------------------------------------------- */

  pendingChanges(): FileChange[] {
    return [...this.changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  changeFor(path: string): FileChange | null {
    return this.changes.get(path) ?? null;
  }

  /** Mark a change accepted. The file already holds the new content. */
  accept(path: string): FileChange | null {
    const change = this.changes.get(path);
    if (!change) return null;
    const next = { ...change, state: 'accepted' as const };
    this.changes.set(path, next);
    return next;
  }

  acceptAll(): FileChange[] {
    for (const [path] of this.changes) this.accept(path);
    return this.pendingChanges();
  }

  /** Undo a change by restoring exactly what was there before. */
  async reject(path: string): Promise<FileChange | null> {
    const change = this.changes.get(path);
    if (!change) return null;
    const abs = this.absolute(path);
    if (change.before === null) {
      await rm(abs, { force: true });
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, change.before, 'utf8');
    }
    const next = { ...change, state: 'rejected' as const };
    this.changes.set(path, next);
    return next;
  }

  async rejectAll(): Promise<FileChange[]> {
    for (const [path, change] of this.changes) {
      if (change.state !== 'rejected') await this.reject(path);
    }
    return this.pendingChanges();
  }

  /** Drop the change log without touching the files. Used when a task is filed away. */
  clearChanges(): void {
    this.changes.clear();
  }

  /** Files an agent has touched during the current task. */
  touchedPaths(): string[] {
    return [...this.changes.keys()];
  }

  /* ---------------------------------------------------------------- */
  /* Checkpoints                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Snapshot the workspace as it stands.
   *
   * Only touched files are copied. Everything else is, by definition,
   * unmodified since the task began, and its pre-task content is already
   * recorded in the change log — so copying the whole tree would cost a great
   * deal to preserve nothing extra.
   */
  async checkpoint(label: string): Promise<WorkspaceCheckpoint> {
    const files: WorkspaceCheckpoint['files'] = [];
    const skipped: string[] = [];

    for (const path of [...this.changes.keys()].sort()) {
      const abs = this.absolute(path);
      try {
        const info = await stat(abs);
        if (info.size > MAX_CHECKPOINT_BYTES) {
          skipped.push(path);
          continue;
        }
        files.push({ path, content: await readFile(abs, 'utf8') });
      } catch {
        // Absent now — which is itself the state to restore.
        files.push({ path, content: null });
      }
    }

    return {
      id: newId('ckpt'),
      label,
      at: Date.now(),
      files,
      skipped,
      changes: this.pendingChanges(),
    };
  }

  /**
   * Restore the workspace to a checkpoint.
   *
   * Files touched after the checkpoint are undone to their pre-task state
   * rather than left behind: a rewind that leaves half of a later step's work
   * on disk produces a tree that never existed, which is worse than either
   * keeping or discarding the whole step.
   */
  async rewind(cp: WorkspaceCheckpoint): Promise<{ restored: string[]; removed: string[]; skipped: string[] }> {
    const restored: string[] = [];
    const removed: string[] = [];
    const inSnapshot = new Set(cp.files.map((f) => f.path));

    for (const path of [...this.changes.keys()]) {
      if (inSnapshot.has(path)) continue;
      const change = this.changes.get(path);
      if (!change) continue;
      // reject() restores exactly what was there before the task touched it.
      await this.reject(path);
      (change.before === null ? removed : restored).push(path);
    }

    for (const file of cp.files) {
      const abs = this.absolute(file.path);
      if (file.content === null) {
        await rm(abs, { force: true });
        removed.push(file.path);
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, 'utf8');
      restored.push(file.path);
    }

    this.changes.clear();
    for (const change of cp.changes) this.changes.set(change.path, { ...change });

    return { restored: [...new Set(restored)].sort(), removed: [...new Set(removed)].sort(), skipped: [...cp.skipped] };
  }
}

/* ------------------------------------------------------------------ */

function byDirThenName(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTS.has(extname(path).toLowerCase());
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Line counts for the diff summary. A changed line counts as both. */
export function countDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const common = lcsLength(a, b);
  return { additions: b.length - common, deletions: a.length - common };
}

/**
 * Length of the longest common subsequence, in O(min(n,m)) space. Exact for the
 * file sizes we read; very large inputs fall back to a line-set estimate so a
 * pathological file cannot stall the request.
 */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 4_000_000) {
    const setB = new Set(b);
    return a.filter((l) => setB.has(l)).length;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length];
}

/** Translate a glob into an anchored RegExp. `**` crosses directories, `*` does not. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may match zero directories, so `**/x` matches a bare `x`.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Unified diff for display and for a model to read. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  const ops = diffLines(a, b);

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 'equal') {
      i += 1;
      continue;
    }
    // Widen the hunk to `context` equal lines either side, then emit it.
    let start = i;
    while (start > 0 && ops[start - 1].kind === 'equal' && i - start < context) start -= 1;
    let end = i;
    while (end < ops.length && (ops[end].kind !== 'equal' || lookaheadHasChange(ops, end, context))) end += 1;
    let tail = 0;
    while (end + tail < ops.length && ops[end + tail].kind === 'equal' && tail < context) tail += 1;
    end += tail;

    const hunk = ops.slice(start, end);
    const aStart = hunk.find((o) => o.aIndex >= 0)?.aIndex ?? 0;
    const bStart = hunk.find((o) => o.bIndex >= 0)?.bIndex ?? 0;
    const aCount = hunk.filter((o) => o.kind !== 'add').length;
    const bCount = hunk.filter((o) => o.kind !== 'del').length;
    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const op of hunk) {
      lines.push(`${op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}${op.text}`);
    }
    i = end;
  }
  return lines.join('\n');
}

function lookaheadHasChange(ops: DiffOp[], from: number, within: number): boolean {
  for (let i = from; i < Math.min(ops.length, from + within + 1); i++) {
    if (ops[i].kind !== 'equal') return true;
  }
  return false;
}

interface DiffOp {
  kind: 'equal' | 'add' | 'del';
  text: string;
  aIndex: number;
  bIndex: number;
}

/**
 * Line diff via LCS backtracking. Exact for normal files; for very large inputs
 * it degrades to a whole-file replacement rather than spending unbounded time.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text, i) => ({ kind: 'del' as const, text, aIndex: i, bIndex: -1 })),
      ...b.map((text, i) => ({ kind: 'add' as const, text, aIndex: -1, bIndex: i })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i], aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i], aIndex: i, bIndex: -1 });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j], aIndex: -1, bIndex: j });
      j += 1;
    }
  }
  while (i < m) ops.push({ kind: 'del', text: a[i], aIndex: i++, bIndex: -1 });
  while (j < n) ops.push({ kind: 'add', text: b[j], aIndex: -1, bIndex: j++ });
  return ops;
}
