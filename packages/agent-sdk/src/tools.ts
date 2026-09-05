import {
  MeridianError,
  newId,
  redact,
  type ToolDefinition,
  type ToolCall,
  type ToolCallRecord,
} from '@meridian/shared';
import type { Sandbox } from './sandbox.js';
import { unifiedDiff, type Workspace } from './workspace.js';

export interface ToolContext {
  workspace: Workspace;
  sandbox: Sandbox;
  taskId: string;
  stepId: string | null;
  signal?: AbortSignal;
  /** Wall-clock ceiling for a single command. */
  commandTimeoutMs: number;
  /** Called for every completed tool call so the UI can show live activity. */
  onRecord?: (record: ToolCallRecord) => void;
}

export interface ToolResult {
  /** What the model sees. Always a string; errors are results, not exceptions. */
  content: string;
  isError: boolean;
  /** Workspace paths this call created or changed. */
  filesTouched?: string[];
  /** Set by the terminal `finish` tool to end the loop. */
  finished?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  /** Read-only tools are safe to run in parallel and never mutate the workspace. */
  readOnly: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const ok = (content: string, filesTouched?: string[]): ToolResult => ({ content, isError: false, filesTouched });
const fail = (content: string): ToolResult => ({ content, isError: true });

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (required) throw new MeridianError('invalid_request', `Missing required argument "${key}"`);
  return '';
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Cap what a single tool result can add to the context window. */
const MAX_RESULT_CHARS = 40_000;

function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[output truncated: ${text.length - max} more characters]`;
}

/* ------------------------------------------------------------------ */
/* File tools                                                         */
/* ------------------------------------------------------------------ */

export const readFileTool: Tool = {
  readOnly: true,
  definition: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the content with line numbers so you can reference specific lines. Use offset and limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        offset: { type: 'number', description: 'First line to return, 1-based' },
        limit: { type: 'number', description: 'How many lines to return' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const path = str(args, 'path');
    const content = await ctx.workspace.read(path);
    const lines = content.split('\n');
    const offset = Math.max(1, num(args, 'offset') ?? 1);
    const limit = num(args, 'limit') ?? 2000;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length - 1).length;
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join('\n');
    const suffix = offset - 1 + slice.length < lines.length ? `\n\n[${lines.length - (offset - 1 + slice.length)} more lines]` : '';
    return ok(clip(numbered + suffix));
  },
};

export const writeFileTool: Tool = {
  readOnly: false,
  definition: {
    name: 'write_file',
    description:
      'Write a file, replacing it entirely if it exists. Prefer edit_file for changes to an existing file — a full rewrite risks losing content you did not read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  async run(args, ctx) {
    const path = str(args, 'path');
    const content = typeof args.content === 'string' ? args.content : '';
    const change = await ctx.workspace.write(path, content);
    return ok(`Wrote ${path} (${change.kind}, +${change.additions} −${change.deletions})`, [path]);
  },
};

export const editFileTool: Tool = {
  readOnly: false,
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. The old_text must appear exactly once unless replace_all is true — include enough surrounding context to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace, including indentation' },
        new_text: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  async run(args, ctx) {
    const path = str(args, 'path');
    const change = await ctx.workspace.edit(path, str(args, 'old_text'), typeof args.new_text === 'string' ? args.new_text : '', args.replace_all === true);
    return ok(`Edited ${path} (+${change.additions} −${change.deletions})`, [path]);
  },
};

export const deleteFileTool: Tool = {
  readOnly: false,
  definition: {
    name: 'delete_file',
    description: 'Delete a file from the workspace. The deletion is recorded and can be undone from the diff review.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  async run(args, ctx) {
    const path = str(args, 'path');
    await ctx.workspace.delete(path);
    return ok(`Deleted ${path}`, [path]);
  },
};

export const listFilesTool: Tool = {
  readOnly: true,
  definition: {
    name: 'list_files',
    description: 'List the workspace file tree. Build output, dependencies and version-control directories are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subdirectory to list. Defaults to the workspace root.' },
        depth: { type: 'number', description: 'Maximum depth, default 4' },
      },
    },
  },
  async run(args, ctx) {
    const tree = await ctx.workspace.tree(str(args, 'path', false), num(args, 'depth') ?? 4);
    const lines: string[] = [];
    const walk = (node: { name: string; type: string; size: number | null; children?: unknown[] }, depth: number): void => {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${node.name}${node.type === 'directory' ? '/' : node.size != null ? `  ${formatBytes(node.size)}` : ''}`);
      for (const child of (node.children ?? []) as typeof node[]) walk(child, depth + 1);
    };
    for (const child of tree.children ?? []) walk(child, 0);
    return ok(clip(lines.join('\n') || '(empty workspace)'));
  },
};

export const globTool: Tool = {
  readOnly: true,
  definition: {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.js".',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  async run(args, ctx) {
    const matches = await ctx.workspace.glob(str(args, 'pattern'));
    return ok(matches.length ? clip(matches.join('\n')) : 'No files matched.');
  },
};

export const grepTool: Tool = {
  readOnly: true,
  definition: {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines with their paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        glob: { type: 'string', description: 'Restrict the search to files matching this glob' },
        case_insensitive: { type: 'boolean' },
        context_lines: { type: 'number', description: 'Lines of surrounding context' },
      },
      required: ['pattern'],
    },
  },
  async run(args, ctx) {
    const hits = await ctx.workspace.grep(str(args, 'pattern'), {
      glob: str(args, 'glob', false) || undefined,
      caseInsensitive: args.case_insensitive === true,
      contextLines: num(args, 'context_lines'),
    });
    if (!hits.length) return ok('No matches.');
    const out = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
    return ok(clip(out));
  },
};

/* ------------------------------------------------------------------ */
/* Execution tools                                                    */
/* ------------------------------------------------------------------ */

export const runCommandTool: Tool = {
  readOnly: false,
  definition: {
    name: 'run_command',
    description:
      'Run a shell command in the sandboxed workspace. Use this for builds, tests, linters and package managers. The command has no access to the gateway\'s credentials.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  },
  async run(args, ctx) {
    const command = str(args, 'command');
    const res = await ctx.sandbox.exec(command, {
      cwd: ctx.workspace.root,
      timeoutMs: Math.min(num(args, 'timeout_ms') ?? ctx.commandTimeoutMs, ctx.commandTimeoutMs),
      signal: ctx.signal,
    });
    const body = [
      res.stdout.trim() ? `stdout:\n${res.stdout.trim()}` : null,
      res.stderr.trim() ? `stderr:\n${res.stderr.trim()}` : null,
      `exit code: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}${res.truncated ? ' (output truncated)' : ''}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    // A non-zero exit is information the model must act on, not a tool failure —
    // returning it as an error would make the model retry rather than debug.
    return { content: clip(body), isError: false };
  },
};

export const gitTool: Tool = {
  readOnly: false,
  definition: {
    name: 'git',
    description:
      'Run a read-only or local git operation in the workspace: status, diff, log, branch, add, commit. Push and remote-mutating operations are not available to agents.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'diff', 'log', 'branch', 'add', 'commit', 'checkout'],
        },
        args: { type: 'string', description: 'Additional arguments, e.g. a commit message or branch name' },
      },
      required: ['operation'],
    },
  },
  async run(args, ctx) {
    const op = str(args, 'operation');
    const extra = str(args, 'args', false);
    // Building the command from a fixed set rather than passing the model's
    // string through keeps `git push --force` and friends out of reach.
    const commands: Record<string, string> = {
      status: 'git status --porcelain=v1 -b',
      diff: `git --no-pager diff ${extra ? shellQuote(extra) : ''}`.trim(),
      log: 'git --no-pager log --oneline -20',
      branch: extra ? `git checkout -b ${shellQuote(extra)}` : 'git branch --show-current',
      add: `git add ${extra ? shellQuote(extra) : '-A'}`,
      commit: `git commit -m ${shellQuote(extra || 'Changes from Meridian agent')}`,
      checkout: extra ? `git checkout ${shellQuote(extra)}` : '',
    };
    const command = commands[op];
    if (!command) return fail(`Unsupported git operation "${op}"`);
    const res = await ctx.sandbox.exec(command, { cwd: ctx.workspace.root, timeoutMs: 30_000, signal: ctx.signal });
    return ok(clip(`${res.stdout}${res.stderr}`.trim() || `exit code ${res.exitCode}`));
  },
};

export const showDiffTool: Tool = {
  readOnly: true,
  definition: {
    name: 'show_diff',
    description: 'Show the unified diff of everything you have changed so far in this task.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, ctx) {
    const changes = ctx.workspace.pendingChanges();
    if (!changes.length) return ok('No changes yet.');
    return ok(clip(changes.map((c) => unifiedDiff(c.path, c.before, c.after)).join('\n\n')));
  },
};

export const finishTool: Tool = {
  readOnly: true,
  definition: {
    name: 'finish',
    description:
      'Call this when the work is complete. Provide a concise summary of what you changed and why. This ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you did, in two or three sentences' },
      },
      required: ['summary'],
    },
  },
  async run(args) {
    return { content: str(args, 'summary'), isError: false, finished: true };
  },
};


/* ------------------------------------------------------------------ */
/* Research                                                           */
/* ------------------------------------------------------------------ */

/**
 * Fetch a URL and reduce it to readable text.
 *
 * This is deliberately an HTTP fetch and not a headless browser: shipping a
 * browser would be a large dependency and a much larger attack surface, and
 * most research targets are server-rendered. Pages that require JavaScript will
 * return little — the tool says so rather than pretending otherwise.
 *
 * Egress from this tool is off unless the operator turns it on, because a model
 * that can fetch arbitrary URLs is a model that can exfiltrate whatever is in
 * its context.
 */
export function createWebFetchTool(opts: { enabled: boolean; timeoutMs?: number; maxBytes?: number }): Tool {
  return {
    readOnly: true,
    definition: {
      name: 'web_fetch',
      description:
        'Fetch a public URL and return its readable text content. Only http(s) URLs are allowed. JavaScript is not executed, so client-rendered pages may return little content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL' },
        },
        required: ['url'],
      },
    },
    async run(args, ctx) {
      if (!opts.enabled) {
        return fail('Web access is disabled on this instance. An operator can enable it in Settings → Security.');
      }
      const raw = str(args, 'url');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return fail(`"${raw}" is not a valid URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return fail('Only http and https URLs can be fetched');
      }
      // Refuse loopback and link-local targets: a fetch tool that can reach
      // 169.254.169.254 or localhost is a cloud-metadata and internal-service
      // exfiltration path, not a research tool.
      if (isPrivateHost(url.hostname)) {
        return fail('Refusing to fetch a loopback, link-local or private-network address');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: ctx.signal ? anySignal([ctx.signal, controller.signal]) : controller.signal,
          headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8' },
        });
        if (!res.ok) return fail(`HTTP ${res.status} from ${url.host}`);
        const type = res.headers.get('content-type') ?? '';
        const body = (await res.text()).slice(0, opts.maxBytes ?? 400_000);
        if (type.includes('json')) return ok(clip(body));
        const text = type.includes('html') ? htmlToText(body) : body;
        return ok(clip(text.trim() || '(the page returned no readable text; it may require JavaScript)'));
      } catch (e) {
        return fail(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

/** Hostnames that must never be fetched on a model's instruction. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Strip markup down to readable prose. Good enough for server-rendered pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ */

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  listFilesTool,
  globTool,
  grepTool,
  runCommandTool,
  gitTool,
  showDiffTool,
  finishTool,
];

export type ToolRegistry = ReadonlyMap<string, Tool>;

/**
 * Build the tool registry for this instance. `web_fetch` only exists when the
 * operator has enabled outbound web access, so an agent cannot discover a
 * capability that is switched off.
 */
export function createToolRegistry(opts: { webAccess: boolean } = { webAccess: false }): ToolRegistry {
  const tools = [...ALL_TOOLS, createWebFetchTool({ enabled: opts.webAccess })];
  return new Map(tools.map((t) => [t.definition.name, t]));
}

/** Read-only subset, for agents that must never modify the workspace. */
export const READ_ONLY_TOOL_NAMES = ALL_TOOLS.filter((t) => t.readOnly).map((t) => t.definition.name);

export function toolDefinitions(registry: ToolRegistry, names: string[]): ToolDefinition[] {
  return names.map((n) => registry.get(n)?.definition).filter((d): d is ToolDefinition => d !== undefined);
}

/**
 * Run one tool call.
 *
 * A tool never throws: a thrown error would end the agent's turn, whereas an
 * error returned as a result is something the model can read, understand and
 * recover from. That distinction is most of what makes an agent loop robust.
 */
export async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  allowed: string[],
  registry: ToolRegistry,
): Promise<{ result: ToolResult; record: ToolCallRecord }> {
  const started = Date.now();
  const tool = registry.get(call.name);
  let result: ToolResult;

  if (!tool) {
    result = fail(`Unknown tool "${call.name}". Available tools: ${allowed.join(', ')}`);
  } else if (!allowed.includes(call.name)) {
    result = fail(`The tool "${call.name}" is not available to this agent. Available tools: ${allowed.join(', ')}`);
  } else {
    try {
      result = await tool.run(call.arguments, ctx);
    } catch (e) {
      const message = e instanceof MeridianError ? e.message : e instanceof Error ? e.message : String(e);
      result = fail(message);
    }
  }

  const record: ToolCallRecord = {
    id: newId('tc'),
    taskId: ctx.taskId,
    stepId: ctx.stepId,
    name: call.name,
    arguments: redact(call.arguments),
    result: result.isError ? null : result.content.slice(0, 4000),
    error: result.isError ? result.content.slice(0, 2000) : null,
    durationMs: Date.now() - started,
    at: started,
  };
  ctx.onRecord?.(record);
  return { result, record };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
