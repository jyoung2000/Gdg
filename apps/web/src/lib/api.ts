import type {
  AgentTask,
  AuditLogEntry,
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
  sandbox: { kind: string; isolation: string; degradedReason: string | null; networkEnabled: boolean };
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
  credentials: () => get<{ credentials: CredentialRecord[]; pools: { id: string; providerId: string; name: string; strategy: string }[] }>('/api/credentials'),
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
};

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
