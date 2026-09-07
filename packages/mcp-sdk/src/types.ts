/**
 * The MCP control plane's vocabulary.
 *
 * A server spec says how to reach a server (spawn it over stdio, or speak
 * streamable HTTP to a URL) and under what permission level it runs. Secrets in
 * env config are stored as opaque handles — the value goes into the vault once
 * and is never echoed back through this layer.
 */

export type McpTransport = 'stdio' | 'http';

export type McpPermissionLevel = 'read_only' | 'safe' | 'development' | 'privileged';

export const MCP_PERMISSION_LEVELS: McpPermissionLevel[] = ['read_only', 'safe', 'development', 'privileged'];

export interface McpEnvVar {
  name: string;
  /** Plain value, or null when the value lives in the vault. */
  value: string | null;
  /** Vault handle for a sealed value. */
  secretHandle: string | null;
  secret: boolean;
}

export interface McpServerSpec {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  /** stdio: the executable and args, run as-is — never through a shell. */
  command: string | null;
  args: string[];
  env: McpEnvVar[];
  cwd: string | null;
  /** http: the streamable HTTP endpoint. */
  url: string | null;
  headers: { name: string; value: string | null; secretHandle: string | null; secret: boolean }[];
  permissionLevel: McpPermissionLevel;
  enabled: boolean;
  /** Where this spec came from: which catalog/registry, or user-added. */
  source: 'official-registry' | 'curated' | 'user' | 'imported';
  createdAt: number;
  updatedAt: number;
}

export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'unhealthy';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpServerHealth {
  serverId: string;
  status: McpServerStatus;
  /** From the server's initialize result, when it got that far. */
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: number;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  latencyMs: number | null;
}

/** A risk the operator must see before granting a level; never auto-granted. */
export interface PermissionWarning {
  kind: 'docker_socket' | 'broad_filesystem' | 'shell_execution' | 'credential_access' | 'network_server';
  detail: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  source: 'official-registry' | 'curated';
  /** Install strategies actually declared by the entry, not guessed. */
  installs: InstallPlan[];
  homepage: string | null;
  /** Env vars the server documents as required. */
  envHints: { name: string; description: string; secret: boolean }[];
  suggestedPermissionLevel: McpPermissionLevel;
}

/**
 * One concrete way to run a server. The exact command is part of the plan so
 * the UI can show the user precisely what would execute before anything runs —
 * installation never executes a script the user has not seen.
 */
export interface InstallPlan {
  kind: 'npx' | 'uvx' | 'docker' | 'http' | 'local';
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Human-readable one-line rendering of what will run. */
  display: string;
  note: string | null;
}

/** Which tools a model/agent may use, resolved most-specific-scope-first. */
export interface McpToolPolicy {
  id: string;
  scope: 'global' | 'workspace' | 'session';
  scopeId: string | null;
  serverId: string;
  /** Empty allow = all tools of the server (minus deny). */
  allowTools: string[];
  denyTools: string[];
  enabled: boolean;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  serverIds: string[];
}

/** Vault indirection so this package never stores raw secrets itself. */
export interface SecretVault {
  seal(value: string): Promise<string>;
  open(handle: string): Promise<string>;
  discard(handle: string): Promise<void>;
}
