import type {
  AgentTask,
  AuditLogEntry,
  Capability,
  CapabilityState,
  CredentialHealth,
  CredentialQuota,
  CredentialRecord,
  FileChange,
  FileNode,
  GenerationJob,
  InferencePool,
  ModelDescriptor,
  ModelPerformance,
  ModelScores,
  ProviderDescriptor,
  ProviderHealth,
  Reservation,
  RoutingDecision,
  RoutingMode,
  TaskEstimate,
  TaskStep,
  ToolCallRecord,
  UsageRecord,
  UserPreferences,
  Workspace,
} from '@meridian/shared';

/* ------------------------------------------------------------------ */
/* Response shapes                                                    */
/* ------------------------------------------------------------------ */

export interface SystemInfo {
  name: string;
  description: string;
  version: string;
  port: number;
  authRequired: boolean;
  allowPaid: boolean;
  defaultRoutingMode: RoutingMode;
  defaultPrivacyMode: string;
  sandbox: { kind: string; isolation: string; isolationSummary: string; degradedReason: string | null; networkEnabled: boolean };
  counts: { providers: number; providersConfigured: number; providersVerified: number; models: number; pools: number; workspaces: number };
  warnings: { level: 'info' | 'warn'; message: string }[];
  endpoints: { openai: string; anthropic: string; events: string };
}

export interface Vocabulary {
  routingModes: { value: RoutingMode; description: string; weights: Record<string, number>; primary: boolean }[];
  privacyModes: { value: string; description: string }[];
  modalities: string[];
  taskTypes: string[];
  capabilities: string[];
  pricingKinds: string[];
  trustLevels: string[];
  agents: { role: string; name: string; description: string; taskType: string; preferredMode: string; pool: string; tools: string[]; maxSteps: number }[];
}

export interface ProviderView extends ProviderDescriptor {
  supportState: 'supported' | 'experimental' | 'not_configured' | 'unavailable';
  health: ProviderHealth;
  cooldownSec: number | null;
  credentials: number;
  models: number;
  freeModels: number;
  paidModels: number;
}

/** Access and economics for one provider, from the synced catalog. */
export interface ProviderIntelligenceView {
  providerId: string;
  freeAccess: string;
  freeTierSummary: string | null;
  rateLimitSummary: string | null;
  caveat: string | null;
  bestFor: string | null;
  expires: string | null;
  requirements: { apiKey: Tri; account: Tri; card: Tri; phone: Tri };
  commercialUse: Tri;
  openAiCompatible: Tri;
  openAiBaseUrl: string | null;
  freeModelIds: string[];
  modalities: string[];
  provenance: {
    source: string;
    sourceUrl: string | null;
    sourceVersion: string | null;
    sourceVerified: boolean;
    lastVerified: string | null;
    confidence: 'high' | 'medium' | 'low';
  };
}

/** Three-valued, because "not confirmed" is a real answer. */
export type Tri = 'yes' | 'no' | 'unknown';

export interface CatalogStatus {
  source: string;
  status: string;
  version: string | null;
  generated: string | null;
  fromCache: boolean;
  fetchedAt: number | null;
  cacheAgeDays: number | null;
  registered: number;
  enriched: number;
  entries: number;
  unroutable: Record<string, number>;
  error: string | null;
  license: string;
  attribution: string;
}

export interface CatalogChange {
  kind: string;
  providerId: string;
  providerName: string;
  before: string | null;
  after: string | null;
  significant: boolean;
}

export interface RouteOptionView {
  modelId: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  free: boolean;
  blendedPerMTok: number | null;
  contextLength: number | null;
  local: boolean;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  reliability: number | null;
  health: string;
  supportState: string;
  freeAccess: string | null;
  configured: boolean;
}

export interface RouteGroupView {
  key: string;
  displayName: string;
  options: RouteOptionView[];
  cheapest: RouteOptionView | null;
  freeRoute: RouteOptionView | null;
  fastest: RouteOptionView | null;
  localRoute: RouteOptionView | null;
}

export interface RadarEntryView {
  option: RouteOptionView;
  score: number;
  factors: { quality: number; reliability: number; availability: number; speed: number };
  note: string;
}

export interface ModelView extends ModelDescriptor {
  free: boolean;
  scores: ModelScores | null;
  performance: ModelPerformance | null;
  status: string;
  supportState: string;
  recommendation: { coding: number; reasoning: number; general: number; bestFor: string; score: number };
}

export interface PoolView extends InferencePool {
  usage: { inFlight: number; spentToday: number; day: string };
  concurrencyLimit: number | null;
  budgetLimit: number | null;
  activeReservation: Reservation | null;
  fallbackChain: string[];
}

export interface UsageSummary {
  totals: { requests: number; tokens: number; cost: number; failures: number; fallbacks: number };
  byModel: { modelId: string; providerId: string; requests: number; tokens: number; cost: number; avgLatency: number; successRate: number }[];
  byDay: { day: string; requests: number; tokens: number; cost: number }[];
  byProvider: { providerId: string; requests: number; cost: number; errorRate: number }[];
}

/**
 * What one request did, reconstructed from what was written down.
 *
 * `attempts` is every try the request made, oldest first — including the ones
 * that failed and the fallback that worked, because a trace that showed only
 * the successful attempt would answer "which model served this" and hide the
 * two that did not.
 */
/**
 * An account's standing with its provider.
 *
 * `available` is the field the UI leads on, because it is the one that answers
 * "will my next call use this key". `unavailableReason` exists so the answer is
 * never a bare no: "rate limited, retrying in 24s" and "no requests quota left"
 * lead to completely different actions, and neither is "add a key".
 */
export interface AccountHealthView extends CredentialHealth {
  available: boolean;
  unavailableReason: string | null;
  quota: CredentialQuota[];
}

/** One row of the capability matrix: everything known about one provider. */
export interface CapabilityMatrixRow {
  providerId: string;
  name: string;
  supportState: string;
  /** A call to this provider has succeeded in this process. Not a capability. */
  hasLiveContact: boolean;
  adapterSurface: Record<string, boolean> | null;
  models: number;
  /** Per modality: could Meridian even attempt it. A ceiling, not evidence. */
  executable: Record<string, boolean>;
  evidence: { capability: Capability; best: CapabilityState; counts: Record<string, number>; models: number }[];
}

export interface CapabilityMatrix {
  capabilities: readonly Capability[];
  modalityMethods: Record<string, string>;
  providers: CapabilityMatrixRow[];
}

export interface RequestTrace {
  requestId: string;
  attempts: UsageRecord[];
  summary: {
    at: number;
    attempts: number;
    succeeded: boolean;
    cost: number;
    promptTokens: number;
    completionTokens: number;
    /** Null when nothing measured it — not the same as having saved nothing. */
    contextTokensSaved: number | null;
    taskId: string | null;
  };
  toolCalls: ToolCallRecord[];
}

export interface RoutingPreview {
  decision: RoutingDecision | null;
  candidates: { modelId: string; providerId: string; score: number; factors: Record<string, number>; estimatedCost: number; estimatedLatencyMs: number | null; free: boolean; model: ModelDescriptor | null }[];
  rejected: { modelId: string; reason: string }[];
}

export interface TaskDetail {
  task: AgentTask;
  steps: TaskStep[];
  toolCalls: {
    id: string;
    stepId: string | null;
    name: string;
    arguments: Record<string, unknown>;
    result: string | null;
    error: string | null;
    durationMs: number;
    at: number;
  }[];
  usage: UsageRecord[];
  running: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  sandbox: { kind: string; isolation: string };
}

/** A failed request, carrying the gateway's own error taxonomy. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly provider: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; code?: string; provider?: string | null } } | null)?.error;
    throw new ApiError(err?.message ?? `Request failed with ${res.status}`, err?.code ?? 'internal', res.status, err?.provider ?? null);
  }
  return parsed as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

/** Build `?a=1&b=2` from the entries that actually have a value. */
function queryString(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /* System */
  info: () => get<SystemInfo>('/api/system/info'),
  vocabulary: () => get<Vocabulary>('/api/system/vocabulary'),
  audit: () => get<{ entries: AuditLogEntry[] }>('/api/system/audit'),
  apiKeys: () => get<{ keys: { id: string; name: string; hint: string; enabled: boolean; createdAt: number; lastUsedAt: number | null }[] }>('/api/system/keys'),
  createApiKey: (name: string) => post<{ id: string; key: string; hint: string; note: string }>('/api/system/keys', { name }),
  deleteApiKey: (id: string) => del<{ removed: boolean }>(`/api/system/keys/${id}`),

  /* Preferences */
  preferences: () => get<UserPreferences>('/api/preferences'),
  savePreferences: (prefs: Partial<UserPreferences>) => put<UserPreferences>('/api/preferences', prefs),

  /* Providers */
  providers: () => get<{ providers: ProviderView[] }>('/api/providers'),
  updateProvider: (id: string, patchBody: { trust?: string; baseUrl?: string; enabled?: boolean; dataUse?: unknown }) =>
    patch<{ ok: boolean }>(`/api/providers/${id}`, patchBody),
  verifyProvider: (id: string) => post<{ ok: boolean; latencyMs?: number; detail?: string; supportState: string }>(`/api/providers/${id}/verify`),
  resetProviderHealth: (id: string) => post<{ health: ProviderHealth }>(`/api/providers/${id}/reset-health`),
  discover: () => post<{ providers: number; models: number }>('/api/providers/discover'),
  health: () => get<{ providers: { providerId: string; name: string; supportState: string; health: ProviderHealth; cooldownSec: number | null }[] }>('/api/health'),

  /* Credentials */
  credentials: () =>
    get<{
      credentials: CredentialRecord[];
      pools: { id: string; providerId: string; name: string; strategy: string }[];
      /** One row per credential the caller may see — the account's standing. */
      health: AccountHealthView[];
    }>('/api/credentials'),
  /** Put an account back into rotation after an operator has fixed it upstream. */
  resetCredentialHealth: (id: string) => post<{ health: AccountHealthView }>(`/api/credentials/${id}/reset-health`, {}),
  addCredential: (body: { providerId: string; secret?: string; label?: string; scope?: string; priority?: number; maxConcurrency?: number }) =>
    post<{ credential: CredentialRecord }>('/api/credentials', body),
  updateCredential: (id: string, body: { secret?: string; enabled?: boolean }) => patch<{ ok: boolean }>(`/api/credentials/${id}`, body),
  deleteCredential: (id: string) => del<{ removed: boolean }>(`/api/credentials/${id}`),

  /* Models */
  models: (q: { search?: string; free?: boolean; provider?: string; modality?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.search) params.set('search', q.search);
    if (q.free) params.set('free', 'true');
    if (q.provider) params.set('provider', q.provider);
    if (q.modality) params.set('modality', q.modality);
    if (q.limit) params.set('limit', String(q.limit));
    return get<{ models: ModelView[]; total: number }>(`/api/models?${params}`);
  },
  model: (id: string) => get<{ model: ModelDescriptor; scores: ModelScores | null; performance: ModelPerformance | null; status: string; free: boolean; benchmarks: unknown[]; provider: ProviderDescriptor | null }>(`/api/models/detail?id=${encodeURIComponent(id)}`),
  benchmark: (modelId: string) => post<{ results: unknown[]; summary: Record<string, number | null> | null; cases: number }>('/api/models/benchmark', { modelId }),
  compare: (body: { models: string[]; prompt: string; taskType?: string; maxTokens?: number }) =>
    post<{ results: { modelId: string; provider: string | null; output: string | null; latencyMs: number; cost: number; toolCalls?: number; error: string | null }[]; totalMs: number }>('/api/models/compare', body),

  /* Routing */
  routingPreview: (body: Record<string, unknown>) => post<RoutingPreview>('/api/routing/preview', body),

  /* Pools */
  pools: () => get<{ pools: PoolView[]; reservations: Reservation[] }>('/api/pools'),
  createPool: (body: Partial<InferencePool>) => post<{ pool: InferencePool }>('/api/pools', body),
  updatePool: (id: string, body: Partial<InferencePool>) => patch<{ pool: InferencePool }>(`/api/pools/${id}`, body),
  deletePool: (id: string) => del<{ removed: boolean }>(`/api/pools/${id}`),
  createReservation: (body: { poolId: string; hours?: number; label?: string; maxConcurrency?: number; budget?: number | null; models?: string[] }) =>
    post<{ reservation: Reservation }>('/api/reservations', body),
  deleteReservation: (id: string) => del<{ removed: boolean }>(`/api/reservations/${id}`),

  /* Model intelligence: synced catalog, routes, free radar */
  catalogStatus: () => get<{ status: CatalogStatus }>('/api/catalog/status'),
  syncCatalog: () => post<{ status: CatalogStatus }>('/api/catalog/sync', {}),
  catalogIntelligence: (q: { free?: boolean; noCard?: boolean; commercial?: boolean } = {}) =>
    get<{ providers: ProviderIntelligenceView[]; total: number }>(
      `/api/catalog/intelligence${queryString({
        free: q.free ? 'true' : undefined,
        noCard: q.noCard ? 'true' : undefined,
        commercial: q.commercial ? 'true' : undefined,
      })}`,
    ),
  catalogChanges: () => get<{ changes: CatalogChange[] }>('/api/catalog/changes'),
  routes: (q: { multiOnly?: boolean; q?: string; limit?: number } = {}) =>
    get<{ groups: RouteGroupView[]; total: number }>(
      `/api/routes${queryString({
        multiOnly: q.multiOnly ? 'true' : undefined,
        q: q.q || undefined,
        limit: q.limit ? String(q.limit) : undefined,
      })}`,
    ),
  freeRadar: (q: { limit?: number; includeUnconfigured?: boolean } = {}) =>
    get<{ entries: RadarEntryView[]; configuredProviders: number }>(
      `/api/radar/free${queryString({
        limit: q.limit ? String(q.limit) : undefined,
        includeUnconfigured: q.includeUnconfigured ? 'true' : undefined,
      })}`,
    ),

  /* Workspaces */
  workspaces: () => get<{ workspaces: Workspace[] }>('/api/workspaces'),
  createWorkspace: (body: { name?: string; repoUrl?: string; branch?: string; privacyMode?: string; defaultMode?: RoutingMode }) =>
    post<{ workspace: Workspace; clone: { ok: boolean; detail?: string } | null }>('/api/workspaces', body),
  workspace: (id: string) => get<{ workspace: Workspace; tree: FileNode; changes: FileChange[] }>(`/api/workspaces/${id}`),
  updateWorkspace: (id: string, body: { name?: string; privacyMode?: string; defaultMode?: RoutingMode }) => patch<{ workspace: Workspace }>(`/api/workspaces/${id}`, body),
  deleteWorkspace: (id: string) => del<{ removed: boolean; note: string }>(`/api/workspaces/${id}`),
  tree: (id: string, path = '', depth = 4) => get<{ tree: FileNode }>(`/api/workspaces/${id}/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
  readFile: (id: string, path: string) => get<{ path: string; content: string }>(`/api/workspaces/${id}/file?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) => put<{ change: FileChange }>(`/api/workspaces/${id}/file`, { path, content }),
  search: (id: string, pattern: string, glob?: string) =>
    get<{ results: { path: string; line: number; text: string }[] }>(`/api/workspaces/${id}/search?pattern=${encodeURIComponent(pattern)}${glob ? `&glob=${encodeURIComponent(glob)}` : ''}`),
  changes: (id: string) => get<{ changes: FileChange[]; diff: string }>(`/api/workspaces/${id}/changes`),
  reviewChange: (id: string, action: 'accept' | 'reject', path?: string) =>
    post<{ change?: FileChange; changes?: FileChange[] }>(`/api/workspaces/${id}/changes`, { action, path }),
  exec: (id: string, command: string) => post<ExecResult>(`/api/workspaces/${id}/exec`, { command }),
  git: (id: string, operation: string, body: { message?: string; branch?: string } = {}) =>
    post<ExecResult & { note?: string }>(`/api/workspaces/${id}/git`, { operation, ...body }),

  /* Tasks */
  tasks: (workspaceId?: string) => get<{ tasks: (AgentTask & { running: boolean })[] }>(`/api/tasks${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
  task: (id: string) => get<TaskDetail>(`/api/tasks/${id}`),
  estimate: (body: { workspaceId: string; request: string; mode?: RoutingMode; allowPaid?: boolean }) =>
    post<{ estimate: TaskEstimate; pipeline: { steps: string[]; rationale: string } }>('/api/tasks/estimate', body),
  createTask: (body: { workspaceId: string; request: string; mode?: RoutingMode; allowPaid?: boolean; budget?: number }) =>
    post<{ task: AgentTask }>('/api/tasks', body),
  cancelTask: (id: string) => post<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`),
  taskFeedback: (id: string, feedback: 'positive' | 'negative') => post<{ applied: number }>(`/api/tasks/${id}/feedback`, { feedback }),
  checkpoints: (id: string) =>
    get<{ checkpoints: { id: string; label: string; at: number; skipped: string[]; fileCount: number; changeCount: number }[] }>(
      `/api/tasks/${id}/checkpoints`,
    ),
  rewindTask: (id: string, checkpointId: string) =>
    post<{ restored: string[]; removed: string[]; skipped: string[]; droppedCheckpoints: number; checkpoint: { label: string } }>(
      `/api/tasks/${id}/rewind`,
      { checkpointId },
    ),
  forkTask: (id: string, body: { request: string; checkpointId?: string; name?: string }) =>
    post<{ task: AgentTask; workspace: Workspace; forkedFrom: { taskId: string } }>(`/api/tasks/${id}/fork`, body),
  parallel: (body: { workspaceId: string; lanes: { name: string; request: string }[]; mode?: RoutingMode; concurrency?: number }) =>
    post<{ runs: unknown[]; conflicts: { path: string; lanes: string[] }[]; usage: unknown }>('/api/tasks/parallel', body),

  /* Generations */
  generations: () => get<{ jobs: GenerationJob[]; aspectRatios: string[] }>('/api/generations'),
  generation: (id: string) => get<{ job: GenerationJob }>(`/api/generations/${id}`),
  generateImage: (body: Record<string, unknown>) => post<{ job: GenerationJob }>('/api/generations/image', body),
  generateVideo: (body: Record<string, unknown>) => post<{ job: GenerationJob }>('/api/generations/video', body),
  generateSpeech: (body: Record<string, unknown>) => post<{ job: GenerationJob }>('/api/generations/speech', body),
  cancelGeneration: (id: string) => post<{ cancelled: boolean }>(`/api/generations/${id}/cancel`),

  /* Usage */
  usage: (days = 30) => get<{ since: number; days: number; summary: UsageSummary; recent: UsageRecord[] }>(`/api/usage?days=${days}`),
  /** Everything one request id did, in the order it did it. */
  trace: (requestId: string) => get<RequestTrace>(`/api/trace/${encodeURIComponent(requestId)}`),

  /**
   * The capability matrix: what Meridian can execute, and how it knows.
   *
   * `executable` is a ceiling from the adapter's own methods; `evidence` is
   * what is known about the provider's models and how strongly.
   */
  capabilityMatrix: () => get<CapabilityMatrix>('/api/capabilities'),

  /* Browser */
  browserEngines: () => get<{ engines: BrowserEngineView[]; configured: { lightpandaCdp: string | null; realBrowserCdp: string | null } }>('/api/browser/engines'),
  browserSessions: () => get<{ sessions: BrowserSessionView[] }>('/api/browser/sessions'),
  browserSession: (id: string) => get<{ session: BrowserSessionView; log: BrowserLogEntry[] }>(`/api/browser/sessions/${id}`),
  createBrowserSession: (body: { engine?: string; task?: string; profile?: string }) => post<{ session: BrowserSessionView }>('/api/browser/sessions', body),
  closeBrowserSession: (id: string, saveProfile = false) => del<{ closed: boolean }>(`/api/browser/sessions/${id}?saveProfile=${saveProfile}`),
  cancelBrowserSession: (id: string) => post<{ cancelled: boolean }>(`/api/browser/sessions/${id}/cancel`),
  browserAction: (id: string, body: Record<string, unknown>) => post<{ snapshot?: PageSnapshotView; result?: string }>(`/api/browser/sessions/${id}/actions`, body),
  browserScreenshot: (id: string) => get<{ data: string; width: number; height: number }>(`/api/browser/sessions/${id}/screenshot`),
  browserProfiles: () => get<{ profiles: { name: string; cookies: number; origins: number; createdAt: number; lastUsedAt: number | null }[] }>('/api/browser/profiles'),

  /* Research */
  scrape: (body: { url: string; fresh?: boolean; engine?: string }) => post<{ snapshot: PageSnapshotView; fromCache: boolean; robots: string }>('/api/research/scrape', body),
  extract: (body: { url: string; objective?: string; fields: { name: string; description: string }[]; noLlm?: boolean }) => post<{ record: ResearchRecordView }>('/api/research/extract', body),
  researchRecords: (limit = 50) => get<{ records: ResearchRecordView[] }>(`/api/research/records?limit=${limit}`),

  /* MCP */
  mcpCatalog: (q = '') => get<{ curated: McpCatalogEntry[]; registry: McpCatalogEntry[]; registryError: string | null }>(`/api/mcp/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  mcpServers: () => get<{ servers: McpServerView[] }>('/api/mcp/servers'),
  addMcpServer: (body: Record<string, unknown>) => post<{ server: McpServerView; warnings: McpWarning[] }>('/api/mcp/servers', body),
  updateMcpServer: (id: string, body: Record<string, unknown>) => patch<{ server: McpServerView }>(`/api/mcp/servers/${id}`, body),
  deleteMcpServer: (id: string) => del<{ deleted: boolean }>(`/api/mcp/servers/${id}`),
  connectMcp: (id: string) => post<{ tools: McpToolView[]; health: McpHealthView }>(`/api/mcp/servers/${id}/connect`),
  disconnectMcp: (id: string) => post<{ disconnected: boolean }>(`/api/mcp/servers/${id}/disconnect`),
  mcpHealth: (id: string) => get<{ health: McpHealthView }>(`/api/mcp/servers/${id}/health`),
  mcpTools: (id: string) => get<{ tools: McpToolView[] }>(`/api/mcp/servers/${id}/tools`),
  revealMcpSecret: (id: string, name: string) => post<{ name: string; value: string }>(`/api/mcp/servers/${id}/reveal`, { name }),
  mcpInstallPlan: (body: { catalogId: string; planIndex?: number; q?: string }) => post<McpInstallPlan>('/api/mcp/install/plan', body),
  mcpInstallConfirm: (body: Record<string, unknown>) => post<{ server: McpServerView; warnings: McpWarning[] }>('/api/mcp/install/confirm', body),
  callMcpTool: (id: string, body: { tool: string; args?: Record<string, unknown> }) => post<{ content: unknown; isError: boolean; latencyMs: number }>(`/api/mcp/servers/${id}/call`, body),
  mcpPolicies: () => get<{ policies: McpPolicyView[] }>('/api/mcp/policies'),
  saveMcpPolicy: (body: Record<string, unknown>) => post<{ policy: McpPolicyView }>('/api/mcp/policies', body),
  deleteMcpPolicy: (id: string) => del<{ deleted: boolean }>(`/api/mcp/policies/${id}`),
  mcpPresets: () => get<{ presets: { id: string; name: string; description: string; serverIds: string[] }[] }>('/api/mcp/presets'),
  saveMcpPreset: (body: Record<string, unknown>) => post<{ preset: unknown }>('/api/mcp/presets', body),
  applyMcpPreset: (id: string) => post<{ applied: boolean }>(`/api/mcp/presets/${id}/apply`),

  /* Docker */
  dockerStatus: () => get<{ docker: { available: boolean; version: string | null; compose: boolean; detail: string | null } }>('/api/docker/status'),
  dockerDetect: (path: string) => post<{ project: DockerProjectView; isolationName: string }>('/api/docker/detect', { path }),
  dockerPs: (path: string) => post<{ containers: DockerContainerView[] }>('/api/docker/ps', { path }),
  dockerLogs: (path: string, service?: string) => post<{ logs: string }>('/api/docker/logs', { path, service }),
  dockerVerify: (body: { path: string; browserCheck?: { expectText?: string } | false; testCommand?: string[] }) => post<{ jobId: string }>('/api/docker/verify', body),
  dockerVerifyJob: (id: string) => get<{ job: DockerVerifyJobView }>(`/api/docker/verify/${id}`),
  dockerVerifyJobs: () => get<{ jobs: { id: string; path: string; status: string; startedAt: number; finishedAt: number | null }[] }>('/api/docker/verify'),

  /* AI control plane */
  skills: () => get<{ skills: SkillView[] }>('/api/skills'),
  createSkill: (body: { slug: string; name: string; content: string; description?: string; tags?: string[]; requiresCapabilities?: string[] }) =>
    post<{ skill: SkillView }>('/api/skills', body),
  updateSkill: (id: string, body: Record<string, unknown>) => patch<{ skill: SkillView }>(`/api/skills/${id}`, body),
  deleteSkill: (id: string) => del<{ deleted: boolean }>(`/api/skills/${id}`),
  importSkills: (skills: { slug: string; name: string; content: string; description?: string }[]) =>
    post<{ imported: number }>('/api/skills/import', { skills }),
  exportSkills: () => get<{ skills: unknown[] }>('/api/skills/export'),

  assignments: (kind?: 'skill' | 'mcp') => get<{ assignments: AssignmentView[] }>(`/api/assignments${kind ? `?kind=${kind}` : ''}`),
  setAssignment: (body: { kind: 'skill' | 'mcp'; targetId: string; scope: string; scopeId?: string | null; mode: 'include' | 'exclude' | 'inherit' }) =>
    put<{ assignment?: AssignmentView; cleared?: boolean }>('/api/assignments', body),

  aiProfiles: () => get<{ profiles: AIProfileView[] }>('/api/ais'),
  createAIProfile: (body: Record<string, unknown>) => post<{ profile: AIProfileView }>('/api/ais', body),
  updateAIProfile: (id: string, body: Record<string, unknown>) => patch<{ profile: AIProfileView }>(`/api/ais/${id}`, body),
  deleteAIProfile: (id: string) => del<{ deleted: boolean }>(`/api/ais/${id}`),

  effectiveConfig: (q: { profileId?: string; modelId?: string; providerId?: string; workspaceId?: string }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    return get<{ config: EffectiveConfigView; explanations: EffectiveExplanations }>(`/api/runtime/effective-config?${params}`);
  },
  capabilitySearch: (body: { query?: string; capabilities?: string[]; localOnly?: boolean; availableOnly?: boolean; limit?: number }) =>
    post<{ requirement: Record<string, unknown>; matches: CapabilityMatchView[]; total: number }>('/api/runtime/capability-search', body),

  modelCapabilities: (modelId: string) => get<ModelCapabilitiesView>(`/api/models/${encodeURIComponent(modelId)}/capabilities`),
  confirmCapability: (modelId: string, capability: string, supported: boolean) =>
    post<{ model: unknown }>(`/api/models/${encodeURIComponent(modelId)}/capabilities`, { capability, supported }),
  /** Probe one model with real requests and record what came back. */
  verifyModel: (modelId: string) =>
    post<{
      probed: number;
      claimsWritten: number;
      inconclusive: number;
      models: { modelId: string; results: { capability: string; outcome: string; detail: string; latencyMs: number }[] }[];
    }>('/api/verification/run', { modelIds: [modelId] }),
  discoverModels: (force = false) => post<{ providers: number; models: number; skipped: string[] }>('/api/models/discover', { force }),
  modelChanges: (limit = 50) => get<{ changes: ModelChangeView[] }>(`/api/models/changes?limit=${limit}`),
  discoveryStatus: () => get<{ schedules: DiscoveryScheduleView[]; intervalMs: number }>('/api/models/discovery-status'),
  connections: () => get<{ connections: ConnectionView[] }>('/api/connections'),

  /* Computer agent */
  computerBackends: () => get<{ backends: ComputerBackendView[] }>('/api/computer/backends'),
  computerVocabulary: () =>
    get<{
      permissions: string[];
      approvalModes: string[];
      presets: { readOnly: Record<string, boolean>; safe: Record<string, boolean> };
      defaultEnabled: boolean;
    }>('/api/computer/vocabulary'),
  computerPlan: (body: { modelId?: string | null; backendId?: string | null; groundingMode?: string; privacyPreference?: string }) =>
    post<{ decision: ComputerPlanView }>('/api/computer/plan', body),
  computerDiagnostics: (backendId?: string) =>
    post<{ checks: ComputerCheckView[]; ok: boolean }>('/api/computer/diagnostics', { backendId }),
  computerSessions: () => get<{ live: ComputerSessionView[]; history: ComputerSessionView[] }>('/api/computer/sessions'),
  computerSession: (id: string) =>
    get<{ session: ComputerSessionView; actions: ComputerActionView[]; live: boolean }>(`/api/computer/sessions/${id}`),
  startComputerSession: (body: Record<string, unknown>) => post<{ session: ComputerSessionView }>('/api/computer/sessions', body),
  computerScreenshot: (id: string) => get<{ data: string; width: number; height: number; at: number }>(`/api/computer/sessions/${id}/screenshot`),
  pauseComputerSession: (id: string) => post<{ paused: boolean }>(`/api/computer/sessions/${id}/pause`, {}),
  resumeComputerSession: (id: string) => post<{ resumed: boolean }>(`/api/computer/sessions/${id}/resume`, {}),
  stopComputerSession: (id: string) => post<{ stopped: boolean; session: ComputerSessionView }>(`/api/computer/sessions/${id}/stop`, {}),
  approveComputerAction: (id: string, approvalId: string, scope: 'once' | 'task') =>
    post<{ approved: boolean }>(`/api/computer/sessions/${id}/approve`, { approvalId, scope }),
  denyComputerAction: (id: string, approvalId: string) => post<{ denied: boolean }>(`/api/computer/sessions/${id}/deny`, { approvalId }),

  /* Git / version control */
  ghInfo: () => get<{ gh: { installed: boolean; version: string | null; authenticated: boolean; detail: string | null } }>('/api/git/gh'),
  gitStatus: (workspaceId: string) => get<{ status: GitStatusView }>(`/api/git/${workspaceId}/status`),
  gitBranches: (workspaceId: string) => get<{ branches: { current: string | null; local: string[]; remote: string[] } }>(`/api/git/${workspaceId}/branches`),
  gitCreateBranch: (workspaceId: string, name: string, from?: string) => post<{ created: string }>(`/api/git/${workspaceId}/branches`, { name, from }),
  gitSwitch: (workspaceId: string, name: string) => post<{ switched: string }>(`/api/git/${workspaceId}/switch`, { name }),
  gitCommit: (workspaceId: string, message: string) => post<{ committed: boolean; output: string }>(`/api/git/${workspaceId}/commit`, { message, addAll: true }),
  gitFetch: (workspaceId: string) => post<{ ok: boolean; output: string }>(`/api/git/${workspaceId}/fetch`),
  gitPull: (workspaceId: string) => post<{ ok: boolean; output: string }>(`/api/git/${workspaceId}/pull`),
  gitPush: (workspaceId: string, setUpstream = false) => post<{ ok: boolean; output: string }>(`/api/git/${workspaceId}/push`, { setUpstream }),
  gitLog: (workspaceId: string, limit = 30) => get<{ commits: { hash: string; subject: string; author: string; at: string }[] }>(`/api/git/${workspaceId}/log?limit=${limit}`),
  gitCreatePr: (workspaceId: string, body: { title: string; body?: string; base?: string; draft?: boolean }) => post<{ url: string | null }>(`/api/git/${workspaceId}/pr`, body),
};

/* ------------------------------------------------------------------ */
/* Control-plane view types                                           */
/* ------------------------------------------------------------------ */

export interface BrowserEngineView {
  id: string;
  available: boolean;
  detail: string | null;
  note: string;
}
export interface BrowserSessionView {
  id: string;
  engine: string;
  profile: string;
  status: string;
  createdAt: number;
  lastActivityAt: number;
  url: string | null;
  title: string | null;
  task: string | null;
  idleTimeoutMs: number;
  pages: number;
  activePage: number;
}
export interface BrowserLogEntry {
  at: number;
  kind: string;
  message: string;
}
export interface SnapshotElementView {
  ref: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
  href?: string;
}
export interface PageSnapshotView {
  url: string;
  title: string;
  text: string;
  outline: string;
  elements: SnapshotElementView[];
  truncated: boolean;
  capturedAt: number;
}
export interface ResearchRecordView {
  id: string;
  objective: string;
  sourceUrl: string;
  finalUrl: string;
  title: string;
  engine: string;
  method: string;
  data: unknown;
  confidence: number;
  modelId: string | null;
  error: string | null;
  at: number;
}
export interface McpInstallPlanStep {
  kind: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  display: string;
  note: string | null;
}
export interface McpCatalogEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  source: string;
  installs: McpInstallPlanStep[];
  homepage: string | null;
  envHints: { name: string; description: string; secret: boolean }[];
  suggestedPermissionLevel: string;
}
export interface McpInstallPlan {
  entry: { id: string; title: string; description: string; homepage: string | null };
  plan: McpInstallPlanStep;
  envHints: { name: string; description: string; secret: boolean }[];
  suggestedPermissionLevel: string;
  note: string;
}
export interface McpWarning {
  kind: string;
  detail: string;
}
export interface McpToolView {
  name: string;
  description: string;
  inputSchema: unknown;
}
export interface McpHealthView {
  serverId: string;
  status: string;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: number;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  latencyMs: number | null;
}
export interface McpServerView {
  id: string;
  name: string;
  description: string;
  transport: string;
  command: string | null;
  args: string[];
  env: { name: string; value: string | null; secret: boolean; secretHandle: string | null }[];
  url: string | null;
  permissionLevel: string;
  enabled: boolean;
  source: string;
  status: string;
  tools: number;
  warnings?: McpWarning[];
  health?: McpHealthView | null;
}
export interface McpPolicyView {
  id: string;
  scope: string;
  scopeId: string | null;
  serverId: string;
  allowTools: string[];
  denyTools: string[];
  enabled: boolean;
}
export interface DockerProjectView {
  path: string;
  kind: string;
  composeFile: string | null;
  dockerfile: string | null;
  services: string[];
}
export interface DockerContainerView {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}
export interface DockerVerifyJobView {
  id: string;
  path: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  log: string[];
  result: {
    ok: boolean;
    attempts: number;
    steps: { name: string; ok: boolean; detail: string; durationMs: number }[];
    failure: { class: string; stage: string; detail: string; retryable: boolean } | null;
    cleaned: boolean;
  } | null;
  error: string | null;
}
export interface GitStatusView {
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

/* ------------------------------------------------------------------ */
/* Chat streaming                                                     */
/* ------------------------------------------------------------------ */

export interface ChatStreamHandlers {
  onStart?: (meta: { model: string; routing?: unknown }) => void;
  onText?: (delta: string) => void;
  onToolCall?: (call: { id: string; name: string; arguments: string }) => void;
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }, cost?: number) => void;
  onDone?: (finishReason: string) => void;
  onError?: (message: string, code: string) => void;
}

/**
 * Stream a chat completion from the OpenAI-compatible endpoint.
 *
 * The client speaks the same public API as any third-party integration — it has
 * no private channel — so anything the UI can do is reproducible with curl.
 */
export async function streamChat(
  body: Record<string, unknown>,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    handlers.onError?.(text || `HTTP ${res.status}`, 'internal');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        let evt: {
          choices?: { delta?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          model?: string;
          meridian?: { routing?: unknown; cost?: number };
          error?: { message: string; code: string };
        };
        try {
          evt = JSON.parse(payload) as typeof evt;
        } catch {
          continue;
        }

        if (evt.error) {
          handlers.onError?.(evt.error.message, evt.error.code);
          return;
        }
        if (evt.meridian?.routing) handlers.onStart?.({ model: evt.model ?? '', routing: evt.meridian.routing });
        if (evt.usage) handlers.onUsage?.(evt.usage, evt.meridian?.cost);

        const choice = evt.choices?.[0];
        if (choice?.delta?.content) handlers.onText?.(choice.delta.content);
        for (const t of choice?.delta?.tool_calls ?? []) {
          handlers.onToolCall?.({ id: t.id ?? '', name: t.function?.name ?? '', arguments: t.function?.arguments ?? '' });
        }
        if (choice?.finish_reason) handlers.onDone?.(choice.finish_reason);
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') handlers.onError?.((e as Error).message, 'internal');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/* ---- control-plane view types ---- */

export interface SkillView {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  requiresCapabilities: string[];
  estimatedTokens: number;
  enabled: boolean;
  version: number;
  source: string;
  createdAt: number;
  updatedAt: number;
}
export interface AssignmentView {
  id: string;
  kind: 'skill' | 'mcp';
  targetId: string;
  scope: string;
  scopeId: string | null;
  mode: 'include' | 'exclude';
}
export interface AIProfileView {
  id: string;
  name: string;
  description: string;
  modelId: string | null;
  providerId: string | null;
  routingMode: string | null;
  requiredCapabilities: string[];
  privacyPreference: string;
  enabled: boolean;
}
export interface ResolutionReasonView {
  targetId: string;
  enabled: boolean;
  decidedBy: string;
  scopeId: string | null;
  mode: string;
  considered: { scope: string; scopeId: string | null; mode: string }[];
  blocked: string | null;
}
export interface EffectiveConfigView {
  profileId: string | null;
  modelId: string | null;
  providerId: string | null;
  skills: { skill: SkillView; reason: ResolutionReasonView }[];
  excludedSkills: ResolutionReasonView[];
  mcpServers: { serverId: string; name: string; reason: ResolutionReasonView }[];
  excludedMcpServers: ResolutionReasonView[];
  skillTokens: number;
  contextLength: number | null;
  contextPressure: number | null;
  warnings: string[];
}
export interface EffectiveExplanations {
  skills: Record<string, string>;
  excludedSkills: Record<string, string>;
  mcpServers: Record<string, string>;
  excludedMcpServers: Record<string, string>;
}
export interface CapabilityMatchView {
  modelId: string;
  providerId: string;
  displayName: string;
  score: number;
  evidence: { capability: string; state: string; source: string }[];
  missing: { capability: string; state: string }[];
  reasons: string[];
  eligible: boolean;
}
export interface ModelCapabilitiesView {
  modelId: string;
  providerId: string;
  displayName: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  modalities: string[];
  pricing: { kind: string };
  discoveredAt: number | null;
  lastVerifiedAt: number | null;
  availability: { available: boolean; local: boolean; detail: string | null };
  capabilities: { capability: string; state: string; source: string }[];
}
export interface ModelChangeView {
  id: string;
  modelId: string;
  at: number;
  kind: string;
  changes: { field: string; from: string | null; to: string | null }[];
}
export interface DiscoveryScheduleView {
  providerId: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  nextEligibleAt: number;
  lastError: string | null;
}
export interface ConnectionView {
  providerId: string;
  name: string;
  connected: boolean;
  method: string;
  credentialSource: string | null;
  hint: string | null;
  models: number;
  health: string;
  lastVerifiedAt: number | null;
  grants: string;
  detail: string | null;
}

/* ---- Computer agent ------------------------------------------------- */

export interface ComputerBackendView {
  id: string;
  name: string;
  description: string;
  surface: 'desktop' | 'browser' | 'remote';
  supportedActions: string[];
  health: { available: boolean; detail: string | null; remediation: string | null; version: string | null };
  screen: { width: number; height: number; groundingWidth: number; groundingHeight: number; displays: number; singleDisplayOnly: boolean } | null;
  needsGrounding: boolean;
}
export interface ComputerPlanView {
  modelId: string | null;
  backendId: string | null;
  groundingModelId: string | null;
  reason: string;
  /** Why this choice, in the user's words. Never an opaque score. */
  factors: string[];
  fallbackModelIds: string[];
  fallbackBackendIds: string[];
  error: string | null;
  ineligible: { modelId: string; reason: string }[];
}
export interface ComputerCheckView {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  remediation: string | null;
}
export interface ComputerVerdictView {
  decision: 'allow' | 'ask' | 'reject';
  risk: 'safe' | 'elevated' | 'destructive';
  reason: string | null;
  requiredPermission: string | null;
}
export interface ComputerApprovalView {
  id: string;
  sessionId: string;
  action: Record<string, unknown> & { type: string };
  verdict: ComputerVerdictView;
  description: string;
  requestedAt: number;
  expiresAt: number;
}
export interface ComputerSessionConfigView {
  task: string;
  backendId: string;
  modelId: string | null;
  providerId: string | null;
  groundingMode: string;
  groundingModelId: string | null;
  permissions: Record<string, boolean>;
  approvalMode: string;
  maxSteps: number;
  actionTimeoutMs: number;
  routingReason: string;
  fallbackModelIds: string[];
  fallbackBackendIds: string[];
  profileId: string | null;
  workspaceId: string | null;
  privacyPreference: string;
}
export interface ComputerSessionView {
  id: string;
  state: string;
  config: ComputerSessionConfigView;
  userId: string | null;
  activeBackendId: string;
  activeModelId: string | null;
  step: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  pendingApproval: ComputerApprovalView | null;
}
export interface ComputerActionView {
  id: string;
  sessionId: string;
  step: number;
  action: Record<string, unknown> & { type: string };
  verdict: ComputerVerdictView;
  status: string;
  result: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  screenshotId: string | null;
}
