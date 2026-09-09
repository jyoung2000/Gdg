import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MERIDIAN_VERSION, MeridianError } from '@meridian/shared';
import type { McpToolInfo } from './types.js';

/**
 * A minimal MCP client speaking both official transports.
 *
 * stdio: the server is spawned directly (argv, no shell) and messages are
 * newline-delimited JSON-RPC on its stdin/stdout. http: JSON-RPC POSTed to the
 * endpoint, answers arriving as JSON or as an SSE stream, with the session id
 * header echoed once the server assigns one.
 */

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface McpConnectStdio {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
}

export interface McpConnectHttp {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
}

export type McpConnectOptions = (McpConnectStdio | McpConnectHttp) & {
  onLog?: (line: string) => void;
  timeoutMs?: number;
};

export interface McpInitializeResult {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export class McpClient {
  private readonly opts: McpConnectOptions;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private sessionId: string | null = null;
  private closed = false;
  initialized: McpInitializeResult | null = null;

  constructor(opts: McpConnectOptions) {
    this.opts = opts;
  }

  private log(line: string): void {
    this.opts.onLog?.(line.slice(0, 500));
  }

  async connect(): Promise<McpInitializeResult> {
    if (this.opts.transport === 'stdio') this.spawnChild();
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'meridian', version: MERIDIAN_VERSION },
    })) as McpInitializeResult & { protocolVersion?: string };
    this.initialized = {
      serverInfo: result.serverInfo ?? { name: 'unknown', version: '0' },
      protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: (result as { capabilities?: Record<string, unknown> }).capabilities ?? {},
    };
    await this.notify('notifications/initialized', {});
    return this.initialized;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list', {})) as { tools?: { name: string; description?: string; inputSchema?: unknown }[] };
    return (result.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }));
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ content: unknown; isError: boolean }> {
    const result = (await this.request('tools/call', { name, arguments: args }, timeoutMs ?? 60_000)) as {
      content?: unknown;
      isError?: boolean;
    };
    return { content: result.content ?? [], isError: result.isError === true };
  }

  async ping(): Promise<void> {
    await this.request('ping', {}, 8_000);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new MeridianError('cancelled', 'MCP client closed'));
    }
    this.pending.clear();
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.stdin?.end();
      // SIGTERM first; a server that ignores it is killed shortly after.
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      killer.unref?.();
    }
  }

  // ---- stdio ---------------------------------------------------------------

  private spawnChild(): void {
    const opts = this.opts as McpConnectStdio & { onLog?: (l: string) => void };
    // argv exec, never a shell: a server name or arg cannot smuggle `; rm`.
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd ?? undefined,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    child.on('error', (e) => this.failAll(new MeridianError('server_error', `MCP server failed to start: ${e.message}`)));
    child.on('exit', (code, signal) => {
      if (!this.closed) this.failAll(new MeridianError('server_error', `MCP server exited (${signal ?? code})`));
    });
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (line.length > MAX_MESSAGE_BYTES) return;
      this.dispatch(line);
    });
    const errRl = createInterface({ input: child.stderr! });
    errRl.on('line', (line) => this.log(`stderr: ${line}`));
  }

  private dispatch(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.log(`non-JSON line ignored: ${line.slice(0, 120)}`);
      return;
    }
    if (msg.method && msg.id === undefined) {
      this.log(`notification: ${msg.method}`);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server-initiated request (sampling, roots). Not supported: refuse
      // politely instead of hanging the server.
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Client does not support server-initiated requests' } });
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new MeridianError('server_error', `MCP error ${msg.error.code}: ${msg.error.message}`));
    else pending.resolve(msg.result);
  }

  private send(payload: unknown): void {
    if (!this.child?.stdin?.writable) throw new MeridianError('server_error', 'MCP server is not running');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  // ---- request plumbing ----------------------------------------------------

  private async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const budget = timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.opts.transport === 'http') return this.httpRequest(method, params, budget);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MeridianError('timeout', `MCP ${method} timed out after ${budget}ms`));
      }, budget);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.opts.transport === 'http') {
      await this.httpPost({ jsonrpc: '2.0', method, params }, 8_000).catch(() => undefined);
      return;
    }
    this.send({ jsonrpc: '2.0', method, params });
  }

  // ---- streamable HTTP -----------------------------------------------------

  private async httpRequest(method: string, params: unknown, budget: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.httpPost({ jsonrpc: '2.0', id, method, params }, budget);
    if (res.error) throw new MeridianError('server_error', `MCP error ${res.error.code}: ${res.error.message}`);
    return res.result;
  }

  private async httpPost(payload: unknown, budget: number): Promise<JsonRpcResponse> {
    const opts = this.opts as McpConnectHttp;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.initialized?.protocolVersion ?? PROTOCOL_VERSION,
      ...opts.headers,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(budget),
    });
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (res.status === 202) return { jsonrpc: '2.0', result: null };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MeridianError('server_error', `MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // The response for this request arrives as SSE events; the message with
      // a matching id (or any error) ends the wait.
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const msg = JSON.parse(dataLines.join('')) as JsonRpcResponse;
          if (msg.result !== undefined || msg.error !== undefined) return msg;
        } catch {
          // Ignore non-JSON events.
        }
      }
      throw new MeridianError('server_error', 'MCP SSE response contained no result');
    }
    return (await res.json()) as JsonRpcResponse;
  }
}
