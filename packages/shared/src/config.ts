import type { PrivacyMode, RoutingMode } from './types.js';

export interface MeridianConfig {
  /** The single port the whole product is served on. */
  port: number;
  host: string;
  /** Absolute path to the SQLite database file. */
  databasePath: string;
  /** Root under which agent workspaces are created. */
  workspaceRoot: string;
  /** Where generated images/video/audio are written. */
  assetRoot: string;
  /** Directory containing the built web client. */
  webRoot: string | null;
  /** Master key for credential encryption. Generated and persisted if unset. */
  masterKey: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'pretty';
  /** Require an API key on gateway routes. */
  authRequired: boolean;
  /** Bootstrap admin credentials, applied only when no users exist. */
  adminEmail: string | null;
  adminPassword: string | null;
  defaultRoutingMode: RoutingMode;
  defaultPrivacyMode: PrivacyMode;
  /** Global kill-switch: when false, no request may ever route to a paid model. */
  allowPaid: boolean;
  /** Max concurrent agent tasks across the instance. */
  maxConcurrentTasks: number;
  /** Requests per minute per API key. */
  rateLimitPerMinute: number;
  /** How long a provider stream may go silent before it is abandoned. */
  streamIdleTimeoutMs: number;
  /** Sandbox strategy for tool execution. */
  sandbox: 'docker' | 'process' | 'disabled';
  sandboxImage: string;
  sandboxTimeoutMs: number;
  sandboxMemoryMb: number;
  sandboxCpus: number;
  /** Enable outbound network from the sandbox. Off by default. */
  sandboxNetwork: boolean;
  /** Poll interval for provider health checks, ms. 0 disables. */
  healthIntervalMs: number;
  /** Poll interval for live model discovery, ms. 0 disables. */
  discoveryIntervalMs: number;
  /** Base URLs probed when auto-discovering local inference servers. */
  localEndpoints: string[];
  corsOrigins: string[];
  trustProxy: boolean;
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(v: string | undefined, dflt: string[]): string[] {
  if (!v) return dflt;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The canonical port. Documented, tested, and used by every entry point. */
export const DEFAULT_PORT = 4639;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MeridianConfig {
  const dataDir = env.MERIDIAN_DATA_DIR ?? './data';
  return {
    port: num(env.PORT ?? env.MERIDIAN_PORT, DEFAULT_PORT),
    host: env.MERIDIAN_HOST ?? '0.0.0.0',
    databasePath: env.MERIDIAN_DB ?? `${dataDir}/meridian.db`,
    workspaceRoot: env.MERIDIAN_WORKSPACE_ROOT ?? './workspaces',
    assetRoot: env.MERIDIAN_ASSET_ROOT ?? `${dataDir}/assets`,
    webRoot: env.MERIDIAN_WEB_ROOT ?? null,
    masterKey: env.MERIDIAN_MASTER_KEY ?? null,
    logLevel: (env.MERIDIAN_LOG_LEVEL as MeridianConfig['logLevel']) ?? 'info',
    logFormat: (env.MERIDIAN_LOG_FORMAT as MeridianConfig['logFormat']) ?? 'json',
    authRequired: bool(env.MERIDIAN_AUTH_REQUIRED, false),
    adminEmail: env.MERIDIAN_ADMIN_EMAIL ?? null,
    adminPassword: env.MERIDIAN_ADMIN_PASSWORD ?? null,
    defaultRoutingMode: (env.MERIDIAN_ROUTING_MODE as RoutingMode) ?? 'AUTO',
    defaultPrivacyMode: (env.MERIDIAN_PRIVACY_MODE as PrivacyMode) ?? 'TRUSTED_ONLY',
    allowPaid: bool(env.MERIDIAN_ALLOW_PAID, false),
    maxConcurrentTasks: num(env.MERIDIAN_MAX_TASKS, 4),
    rateLimitPerMinute: num(env.MERIDIAN_RATE_LIMIT, 240),
    streamIdleTimeoutMs: num(env.MERIDIAN_STREAM_IDLE_TIMEOUT_MS, 90_000),
    sandbox: (env.MERIDIAN_SANDBOX as MeridianConfig['sandbox']) ?? 'process',
    sandboxImage: env.MERIDIAN_SANDBOX_IMAGE ?? 'meridian-sandbox:latest',
    sandboxTimeoutMs: num(env.MERIDIAN_SANDBOX_TIMEOUT_MS, 120_000),
    sandboxMemoryMb: num(env.MERIDIAN_SANDBOX_MEMORY_MB, 2048),
    sandboxCpus: num(env.MERIDIAN_SANDBOX_CPUS, 2),
    sandboxNetwork: bool(env.MERIDIAN_SANDBOX_NETWORK, false),
    healthIntervalMs: num(env.MERIDIAN_HEALTH_INTERVAL_MS, 120_000),
    discoveryIntervalMs: num(env.MERIDIAN_DISCOVERY_INTERVAL_MS, 900_000),
    localEndpoints: list(env.MERIDIAN_LOCAL_ENDPOINTS, [
      'http://localhost:11434',
      'http://host.docker.internal:11434',
      'http://localhost:8000',
      'http://localhost:8080',
      'http://localhost:1234',
    ]),
    corsOrigins: list(env.MERIDIAN_CORS_ORIGINS, []),
    trustProxy: bool(env.MERIDIAN_TRUST_PROXY, false),
  };
}
