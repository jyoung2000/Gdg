import { randomUUID } from 'node:crypto';
import { MeridianError } from '@meridian/shared';
import { McpClient, type McpConnectOptions } from './client.js';
import type {
  McpEnvVar,
  McpPermissionLevel,
  McpPreset,
  McpServerHealth,
  McpServerSpec,
  McpToolInfo,
  McpToolPolicy,
  PermissionWarning,
  SecretVault,
} from './types.js';

/** Persistence hooks; the gateway backs these with SQLite, tests with memory. */
export interface McpStore {
  loadServers(): Promise<McpServerSpec[]>;
  saveServer(spec: McpServerSpec): Promise<void>;
  deleteServer(id: string): Promise<void>;
  loadPolicies(): Promise<McpToolPolicy[]>;
  savePolicy(policy: McpToolPolicy): Promise<void>;
  deletePolicy(id: string): Promise<void>;
  loadPresets(): Promise<McpPreset[]>;
  savePreset(preset: McpPreset): Promise<void>;
  deletePreset(id: string): Promise<void>;
}

export class MemoryMcpStore implements McpStore {
  private servers = new Map<string, McpServerSpec>();
  private policies = new Map<string, McpToolPolicy>();
  private presets = new Map<string, McpPreset>();
  async loadServers() {
    return Array.from(this.servers.values());
  }
  async saveServer(s: McpServerSpec) {
    this.servers.set(s.id, s);
  }
  async deleteServer(id: string) {
    this.servers.delete(id);
  }
  async loadPolicies() {
    return Array.from(this.policies.values());
  }
  async savePolicy(p: McpToolPolicy) {
    this.policies.set(p.id, p);
  }
  async deletePolicy(id: string) {
    this.policies.delete(id);
  }
  async loadPresets() {
    return Array.from(this.presets.values());
  }
  async savePreset(p: McpPreset) {
    this.presets.set(p.id, p);
  }
  async deletePreset(id: string) {
    this.presets.delete(id);
  }
}

/** An in-memory vault for tests only; the gateway injects its sealed store. */
export class MemoryVault implements SecretVault {
  private values = new Map<string, string>();
  async seal(value: string) {
    const handle = `vault_${randomUUID()}`;
    this.values.set(handle, value);
    return handle;
  }
  async open(handle: string) {
    const v = this.values.get(handle);
    if (v === undefined) throw new MeridianError('invalid_request', 'Unknown secret handle');
    return v;
  }
  async discard(handle: string) {
    this.values.delete(handle);
  }
}

export interface ServerInput {
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  env?: { name: string; value: string; secret?: boolean }[];
  cwd?: string | null;
  url?: string | null;
  headers?: { name: string; value: string; secret?: boolean }[];
  permissionLevel?: McpPermissionLevel;
  source?: McpServerSpec['source'];
}

interface LiveConnection {
  client: McpClient;
  tools: McpToolInfo[];
  connectedAt: number;
}

/**
 * The MCP control plane: server configs with sealed secrets, connections,
 * health, tool policies, presets, and the permission analysis that keeps
 * dangerous grants explicit.
 */
export class McpManager {
  private readonly store: McpStore;
  private readonly vault: SecretVault;
  private readonly now: () => number;
  private readonly onLog?: (serverId: string, line: string) => void;

  private specs = new Map<string, McpServerSpec>();
  private policies = new Map<string, McpToolPolicy>();
  private presets = new Map<string, McpPreset>();
  private readonly connections = new Map<string, LiveConnection>();
  private readonly health = new Map<string, McpServerHealth>();
  private loaded = false;

  constructor(opts: { store?: McpStore; vault?: SecretVault; now?: () => number; onLog?: (serverId: string, line: string) => void }) {
    this.store = opts.store ?? new MemoryMcpStore();
    this.vault = opts.vault ?? new MemoryVault();
    this.now = opts.now ?? (() => Date.now());
    this.onLog = opts.onLog;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    for (const s of await this.store.loadServers()) this.specs.set(s.id, s);
    for (const p of await this.store.loadPolicies()) this.policies.set(p.id, p);
    for (const p of await this.store.loadPresets()) this.presets.set(p.id, p);
    this.loaded = true;
  }

  // ---- servers -------------------------------------------------------------

  async addServer(input: ServerInput): Promise<McpServerSpec> {
    if (input.transport === 'stdio' && !input.command) throw new MeridianError('invalid_request', 'A stdio server needs a command');
    if (input.transport === 'http') {
      if (!input.url) throw new MeridianError('invalid_request', 'An HTTP server needs a URL');
      if (!/^https?:\/\//.test(input.url)) throw new MeridianError('invalid_request', 'The server URL must be http(s)');
    }
    const env: McpEnvVar[] = [];
    for (const e of input.env ?? []) {
      const secret = e.secret ?? /key|token|secret|password|credential/i.test(e.name);
      env.push(
        secret
          ? { name: e.name, value: null, secretHandle: await this.vault.seal(e.value), secret: true }
          : { name: e.name, value: e.value, secretHandle: null, secret: false },
      );
    }
    const headers: McpServerSpec['headers'] = [];
    for (const h of input.headers ?? []) {
      const secret = h.secret ?? /auth|key|token|secret/i.test(h.name);
      headers.push(
        secret
          ? { name: h.name, value: null, secretHandle: await this.vault.seal(h.value), secret: true }
          : { name: h.name, value: h.value, secretHandle: null, secret: false },
      );
    }
    const spec: McpServerSpec = {
      id: `mcp_${randomUUID().slice(0, 12)}`,
      name: input.name,
      description: input.description ?? '',
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      env,
      cwd: input.cwd ?? null,
      url: input.url ?? null,
      headers,
      permissionLevel: input.permissionLevel ?? 'safe',
      enabled: true,
      source: input.source ?? 'user',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.specs.set(spec.id, spec);
    await this.store.saveServer(spec);
    return spec;
  }

  async updateServer(
    id: string,
    patch: Partial<Pick<McpServerSpec, 'name' | 'description' | 'args' | 'cwd' | 'url' | 'permissionLevel' | 'enabled' | 'command'>> & {
      env?: { name: string; value: string | null; secret?: boolean }[];
    },
  ): Promise<McpServerSpec> {
    const spec = this.mustGet(id);
    Object.assign(spec, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.permissionLevel !== undefined ? { permissionLevel: patch.permissionLevel } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    if (patch.env) {
      const next: McpEnvVar[] = [];
      for (const e of patch.env) {
        const existing = spec.env.find((x) => x.name === e.name);
        if (e.value === null) {
          // null value = keep the stored one (secret stays sealed).
          if (existing) next.push(existing);
          continue;
        }
        if (existing?.secretHandle) await this.vault.discard(existing.secretHandle).catch(() => undefined);
        const secret = e.secret ?? existing?.secret ?? /key|token|secret|password|credential/i.test(e.name);
        next.push(
          secret
            ? { name: e.name, value: null, secretHandle: await this.vault.seal(e.value), secret: true }
            : { name: e.name, value: e.value, secretHandle: null, secret: false },
        );
      }
      spec.env = next;
    }
    spec.updatedAt = this.now();
    await this.store.saveServer(spec);
    if (patch.enabled === false) await this.disconnect(id);
    return spec;
  }

  async removeServer(id: string): Promise<void> {
    const spec = this.specs.get(id);
    if (!spec) return;
    await this.disconnect(id);
    for (const e of spec.env) if (e.secretHandle) await this.vault.discard(e.secretHandle).catch(() => undefined);
    for (const h of spec.headers) if (h.secretHandle) await this.vault.discard(h.secretHandle).catch(() => undefined);
    this.specs.delete(id);
    this.health.delete(id);
    await this.store.deleteServer(id);
  }

  listServers(): (McpServerSpec & { status: McpServerHealth['status']; tools: number })[] {
    return Array.from(this.specs.values()).map((spec) => ({
      ...this.redact(spec),
      status: this.connections.has(spec.id) ? 'running' : (this.health.get(spec.id)?.status ?? 'stopped'),
      tools: this.connections.get(spec.id)?.tools.length ?? this.health.get(spec.id)?.tools ?? 0,
    }));
  }

  getServer(id: string): McpServerSpec {
    return this.redact(this.mustGet(id));
  }

  /** Secrets never leave as values: sealed entries come back with value null. */
  private redact(spec: McpServerSpec): McpServerSpec {
    return {
      ...spec,
      env: spec.env.map((e) => ({ ...e, value: e.secret ? null : e.value, secretHandle: e.secretHandle ? 'sealed' : null })),
      headers: spec.headers.map((h) => ({ ...h, value: h.secret ? null : h.value, secretHandle: h.secretHandle ? 'sealed' : null })),
    };
  }

  /**
   * The one deliberate way to see a stored secret again. The gateway gates
   * this behind admin scope and logs it; nothing calls it implicitly.
   */
  async revealSecret(id: string, envName: string): Promise<string> {
    const spec = this.mustGet(id);
    const entry = spec.env.find((e) => e.name === envName) ?? spec.headers.find((h) => h.name === envName);
    if (!entry?.secretHandle) throw new MeridianError('invalid_request', `${envName} has no sealed value`);
    return this.vault.open(entry.secretHandle);
  }

  // ---- permission analysis -------------------------------------------------

  /** Risks the operator must acknowledge; derived from the config itself. */
  warningsFor(id: string): PermissionWarning[] {
    const spec = this.mustGet(id);
    const warnings: PermissionWarning[] = [];
    const joined = [spec.command ?? '', ...spec.args].join(' ');
    if (/docker\.sock|docker\s+run|docker\s+exec/i.test(joined)) {
      warnings.push({ kind: 'docker_socket', detail: 'This server touches Docker; a container escape or broad mounts can reach the host.' });
    }
    if (spec.args.some((a) => a === '/' || a === '/home' || a === '/etc' || a === process.env.HOME)) {
      warnings.push({ kind: 'broad_filesystem', detail: 'This server is given a very broad filesystem root.' });
    }
    if (/\b(bash|sh|zsh)\b\s+-c|shell/i.test(joined) || /shell/i.test(spec.name)) {
      warnings.push({ kind: 'shell_execution', detail: 'This server can run shell commands with the gateway\'s privileges.' });
    }
    if (spec.env.some((e) => e.secret)) {
      warnings.push({ kind: 'credential_access', detail: 'This server receives sealed credentials as environment variables.' });
    }
    if (spec.transport === 'http') {
      warnings.push({ kind: 'network_server', detail: 'This server runs remotely; tool inputs and outputs leave this machine.' });
    }
    return warnings;
  }

  // ---- connection & health -------------------------------------------------

  async connect(id: string): Promise<{ tools: McpToolInfo[]; health: McpServerHealth }> {
    const spec = this.mustGet(id);
    if (!spec.enabled) throw new MeridianError('invalid_request', `${spec.name} is disabled`);
    const existing = this.connections.get(id);
    if (existing) return { tools: existing.tools, health: this.health.get(id)! };

    const started = this.now();
    const client = new McpClient(await this.connectOptions(spec));
    try {
      const init = await client.connect();
      const tools = await client.listTools();
      this.connections.set(id, { client, tools, connectedAt: this.now() });
      const health: McpServerHealth = {
        serverId: id,
        status: 'running',
        serverInfo: init.serverInfo,
        protocolVersion: init.protocolVersion,
        tools: tools.length,
        lastCheckAt: this.now(),
        lastOkAt: this.now(),
        error: null,
        latencyMs: this.now() - started,
      };
      this.health.set(id, health);
      return { tools, health };
    } catch (e) {
      await client.close().catch(() => undefined);
      const health: McpServerHealth = {
        serverId: id,
        status: 'failed',
        serverInfo: null,
        protocolVersion: null,
        tools: 0,
        lastCheckAt: this.now(),
        lastOkAt: this.health.get(id)?.lastOkAt ?? null,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: null,
      };
      this.health.set(id, health);
      throw e;
    }
  }

  private async connectOptions(spec: McpServerSpec): Promise<McpConnectOptions> {
    if (spec.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const e of spec.env) env[e.name] = e.secretHandle ? await this.vault.open(e.secretHandle) : (e.value ?? '');
      return {
        transport: 'stdio',
        command: spec.command!,
        args: spec.args,
        env,
        cwd: spec.cwd,
        onLog: (line) => this.onLog?.(spec.id, line),
      };
    }
    const headers: Record<string, string> = {};
    for (const h of spec.headers) headers[h.name] = h.secretHandle ? await this.vault.open(h.secretHandle) : (h.value ?? '');
    return { transport: 'http', url: spec.url!, headers, onLog: (line) => this.onLog?.(spec.id, line) };
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    await conn.client.close();
    const h = this.health.get(id);
    if (h) this.health.set(id, { ...h, status: 'stopped' });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.connections.keys()).map((id) => this.disconnect(id)));
  }

  /** Connects if needed, measures a live round-trip, reports honestly. */
  async checkHealth(id: string): Promise<McpServerHealth> {
    const spec = this.mustGet(id);
    if (!spec.enabled) {
      const health: McpServerHealth = {
        serverId: id,
        status: 'stopped',
        serverInfo: null,
        protocolVersion: null,
        tools: 0,
        lastCheckAt: this.now(),
        lastOkAt: this.health.get(id)?.lastOkAt ?? null,
        error: 'disabled',
        latencyMs: null,
      };
      this.health.set(id, health);
      return health;
    }
    const conn = this.connections.get(id);
    if (!conn) {
      try {
        return (await this.connect(id)).health;
      } catch {
        return this.health.get(id)!;
      }
    }
    const started = this.now();
    try {
      const tools = await conn.client.listTools();
      conn.tools = tools;
      const health: McpServerHealth = {
        serverId: id,
        status: 'running',
        serverInfo: conn.client.initialized?.serverInfo ?? null,
        protocolVersion: conn.client.initialized?.protocolVersion ?? null,
        tools: tools.length,
        lastCheckAt: this.now(),
        lastOkAt: this.now(),
        error: null,
        latencyMs: this.now() - started,
      };
      this.health.set(id, health);
      return health;
    } catch (e) {
      await this.disconnect(id);
      const health: McpServerHealth = {
        serverId: id,
        status: 'unhealthy',
        serverInfo: null,
        protocolVersion: null,
        tools: 0,
        lastCheckAt: this.now(),
        lastOkAt: this.health.get(id)?.lastOkAt ?? null,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: null,
      };
      this.health.set(id, health);
      return health;
    }
  }

  healthOf(id: string): McpServerHealth | null {
    return this.health.get(id) ?? null;
  }

  toolsOf(id: string): McpToolInfo[] {
    return this.connections.get(id)?.tools ?? [];
  }

  // ---- tool calls ----------------------------------------------------------

  async callTool(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    context?: { workspaceId?: string | null; sessionId?: string | null },
  ): Promise<{ content: unknown; isError: boolean }> {
    const spec = this.mustGet(id);
    const verdict = this.toolAllowed(id, tool, context);
    if (!verdict.allowed) throw new MeridianError('invalid_request', `Tool ${tool} on ${spec.name} is blocked: ${verdict.reason}`);
    let conn = this.connections.get(id);
    if (!conn) {
      await this.connect(id);
      conn = this.connections.get(id)!;
    }
    if (conn.tools.length > 0 && !conn.tools.some((t) => t.name === tool)) {
      throw new MeridianError('invalid_request', `${spec.name} does not expose a tool named ${tool}`);
    }
    return conn.client.callTool(tool, args);
  }

  // ---- policies ------------------------------------------------------------

  async setPolicy(input: Omit<McpToolPolicy, 'id'> & { id?: string }): Promise<McpToolPolicy> {
    const policy: McpToolPolicy = { ...input, id: input.id ?? `mpol_${randomUUID().slice(0, 10)}` };
    this.policies.set(policy.id, policy);
    await this.store.savePolicy(policy);
    return policy;
  }

  async deletePolicy(id: string): Promise<void> {
    this.policies.delete(id);
    await this.store.deletePolicy(id);
  }

  listPolicies(): McpToolPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Most specific scope wins outright: a session policy overrides a workspace
   * policy overrides a global one. Within the winning policy, deny beats
   * allow; with no policy at all, an enabled server's tools are usable.
   */
  toolAllowed(serverId: string, tool: string, context?: { workspaceId?: string | null; sessionId?: string | null }): {
    allowed: boolean;
    reason: string | null;
  } {
    const spec = this.specs.get(serverId);
    if (!spec) return { allowed: false, reason: 'unknown server' };
    if (!spec.enabled) return { allowed: false, reason: 'server disabled' };

    const all = Array.from(this.policies.values()).filter((p) => p.serverId === serverId && p.enabled);
    const chain: McpToolPolicy[] = [
      ...all.filter((p) => p.scope === 'session' && p.scopeId === context?.sessionId),
      ...all.filter((p) => p.scope === 'workspace' && p.scopeId === context?.workspaceId),
      ...all.filter((p) => p.scope === 'global'),
    ];
    const winner = chain[0];
    if (!winner) return { allowed: true, reason: null };
    if (winner.denyTools.includes(tool)) return { allowed: false, reason: `denied by ${winner.scope} policy` };
    if (winner.allowTools.length > 0 && !winner.allowTools.includes(tool)) {
      return { allowed: false, reason: `not in the ${winner.scope} policy's allow list` };
    }
    return { allowed: true, reason: null };
  }

  // ---- presets -------------------------------------------------------------

  async savePreset(input: Omit<McpPreset, 'id'> & { id?: string }): Promise<McpPreset> {
    const preset: McpPreset = { ...input, id: input.id ?? `mpre_${randomUUID().slice(0, 10)}` };
    this.presets.set(preset.id, preset);
    await this.store.savePreset(preset);
    return preset;
  }

  async deletePreset(id: string): Promise<void> {
    this.presets.delete(id);
    await this.store.deletePreset(id);
  }

  listPresets(): McpPreset[] {
    return Array.from(this.presets.values());
  }

  /** Enable exactly the preset's servers; others are disabled, not removed. */
  async applyPreset(id: string): Promise<void> {
    const preset = this.presets.get(id);
    if (!preset) throw new MeridianError('invalid_request', `No preset ${id}`);
    for (const spec of this.specs.values()) {
      const want = preset.serverIds.includes(spec.id);
      if (spec.enabled !== want) await this.updateServer(spec.id, { enabled: want });
    }
  }

  private mustGet(id: string): McpServerSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new MeridianError('invalid_request', `No MCP server ${id}`);
    return spec;
  }
}
