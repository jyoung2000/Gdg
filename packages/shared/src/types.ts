/**
 * Meridian core domain types.
 *
 * This file is the single source of truth for the vocabulary shared by the
 * gateway, the router, the provider adapters, the agent runtime, the CLI and
 * the web client. Everything else in the monorepo depends on it; nothing in
 * here depends on anything else.
 */

/* ------------------------------------------------------------------ */
/* Modalities and tasks                                                */
/* ------------------------------------------------------------------ */

export const MODALITIES = [
  'text',
  'vision',
  'image',
  'video',
  'audio',
  'speech',
  'transcription',
  'embedding',
] as const;
export type Modality = (typeof MODALITIES)[number];

export const TASK_TYPES = [
  'chat',
  'coding',
  'reasoning',
  'research',
  'planning',
  'file-search',
  'review',
  'test',
  'debug',
  'summarize',
  'classify',
  'extract',
  'translate',
  'tool-use',
  'embedding',
  'image-generation',
  'video-generation',
  'speech-synthesis',
  'transcription',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Capabilities a model may advertise. Routing filters on these. */
export const CAPABILITIES = [
  'text',
  'vision',
  'tools',
  'json-mode',
  'structured-output',
  'streaming',
  'reasoning',
  'long-context',
  'image-generation',
  'image-editing',
  'video-generation',
  'speech-synthesis',
  'transcription',
  'embedding',
  'prefix-caching',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/* ------------------------------------------------------------------ */
/* Economics                                                           */
/* ------------------------------------------------------------------ */

/**
 * How a model is paid for. Deliberately explicit: a promotional credit is
 * never labelled the same as a permanent free tier (spec requirement).
 */
export const PRICING_KINDS = [
  'FREE',
  'FREE_DAILY',
  'FREE_MONTHLY',
  'TRIAL',
  'CREDIT',
  'FLAT',
  'RESERVATION',
  'METERED',
  'LOCAL',
  'PAID',
  'UNKNOWN',
] as const;
export type PricingKind = (typeof PRICING_KINDS)[number];

/** Pricing kinds that never draw down real money for the operator. */
export const NON_SPENDING_PRICING: readonly PricingKind[] = [
  'FREE',
  'FREE_DAILY',
  'FREE_MONTHLY',
  'LOCAL',
];

/**
 * How a route relates to the operator's money.
 *
 * The fourth member is the one that matters. A metered model whose rates are
 * simply unpublished is not free and not priced — it is unknown, and every
 * comparison that collapses it into either of the other two gets the answer
 * wrong in a way that costs real money. `SUBSCRIPTION_INCLUDED` is declared
 * because routing has to be able to express it, but nothing constructs it yet:
 * see `costClass` in economics.ts.
 */
export const COST_CLASSES = ['FREE', 'SUBSCRIPTION_INCLUDED', 'KNOWN_PAID', 'UNKNOWN_COST'] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/** How much of a price was actually published. */
export const COST_BASES = ['exact', 'lower_bound', 'unknown'] as const;
export type CostBasis = (typeof COST_BASES)[number];

export interface Pricing {
  kind: PricingKind;
  /** USD per 1M input tokens. null when unknown or not token-metered. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens. */
  outputPerMTok: number | null;
  /** USD per request, for per-image / per-second style billing. */
  perRequest: number | null;
  /** Free-tier allowance, when the provider publishes one. */
  freeQuota?: {
    requestsPerDay?: number;
    requestsPerMinute?: number;
    tokensPerDay?: number;
    tokensPerMinute?: number;
  } | null;
  /** Free-form note shown in the UI, e.g. "trial credits expire after 30d". */
  note?: string | null;
}

/* ------------------------------------------------------------------ */
/* Trust, privacy, data use                                            */
/* ------------------------------------------------------------------ */

export const TRUST_LEVELS = ['verified', 'trusted', 'unknown', 'untrusted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const PRIVACY_MODES = [
  'STRICT_LOCAL',
  'TRUSTED_ONLY',
  'FREE_PROVIDERS',
  'ANY_PROVIDER',
] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/**
 * Tri-state on purpose. "unknown" is a real answer and must never be
 * silently rendered as "allowed" or "not allowed".
 */
export type DataUseFlag = 'allowed' | 'not_allowed' | 'unknown';

export interface DataUsePolicy {
  /** Does the provider train on submitted content? */
  trainingUse: DataUseFlag;
  /** Is commercial use of outputs permitted? */
  commercialUse: DataUseFlag;
  /** Is the request retained, and for how long (free text). */
  retention: string | null;
  /** Provider's published privacy posture, free text. */
  privacyNote: string | null;
  /** Where the operator can read the authoritative policy. */
  policyUrl: string | null;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export const PROVIDER_KINDS = [
  'llm',
  'coding',
  'image',
  'video',
  'audio',
  'speech',
  'embedding',
  'local',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const AUTH_KINDS = ['none', 'api-key', 'bearer', 'oauth', 'custom'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * Integration maturity. A provider is only ever shown as "supported" when an
 * adapter exists AND its capabilities were verified against the live API.
 */
export const SUPPORT_STATES = [
  'supported',
  'experimental',
  'not_configured',
  'unavailable',
  /** Registered and remembered, but the operator has switched it off. */
  'disabled',
] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

export interface ProviderDescriptor {
  /** Stable slug, e.g. "openrouter". */
  id: string;
  name: string;
  kinds: ProviderKind[];
  /** Adapter implementation key registered in the provider registry. */
  adapter: string;
  baseUrl: string;
  auth: AuthKind;
  /** Env var names checked during automatic credential discovery. */
  /**
   * Environment variables that may carry this provider's credential.
   *
   * Credentials only. A variable listed here is read as a secret, sealed and
   * sent as this provider's key — so an endpoint override must never appear in
   * it. Use {@link ProviderDescriptor.baseUrlEnvKeys} for that.
   */
  envKeys: string[];
  /** Environment variables that override {@link ProviderDescriptor.baseUrl}. */
  baseUrlEnvKeys?: string[];
  trust: TrustLevel;
  docsUrl: string | null;
  /** True when the provider runs on the operator's own hardware. */
  local: boolean;
  /** Does the provider expose a model-listing endpoint we can discover from? */
  supportsDiscovery: boolean;
  dataUse: DataUsePolicy;
  /** Default pricing posture for models that don't declare their own. */
  defaultPricing: Pricing;
  /** Provider-level rate limits, when published. */
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    requestsPerDay?: number;
  } | null;
  notes?: string | null;
}

export const HEALTH_STATES = [
  'healthy',
  'degraded',
  'rate_limited',
  'unauthorized',
  'offline',
  'unknown',
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface ProviderHealth {
  providerId: string;
  state: HealthState;
  /** Circuit breaker: closed = traffic flows, open = shed, half_open = probe. */
  circuit: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  /** Rolling mean latency in ms across recent successful calls. */
  latencyMs: number | null;
  /** Rolling error rate in [0,1]. */
  errorRate: number;
  /** Epoch ms until which the provider is in cooldown. */
  cooldownUntil: number | null;
  lastCheckedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export const MODEL_STATUSES = [
  'ready',
  'busy',
  'rate_limited',
  'degraded',
  'offline',
  'unknown',
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export interface ModelDescriptor {
  /** Globally unique: `${providerId}:${providerModelId}`. */
  id: string;
  providerId: string;
  /** The id the provider itself expects in an API call. */
  providerModelId: string;
  displayName: string;
  family: string | null;
  modalities: Modality[];
  capabilities: Capability[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  pricing: Pricing;
  /** Set when discovered live from the provider rather than a static catalog. */
  discovered: boolean;
  deprecated: boolean;
  /** Free-form tags used by pools and the UI. */
  tags: string[];
  updatedAt: number;
  /**
   * Per-capability evidence. `capabilities` above stays the fast path every
   * routing decision reads; this records how each entry was established, so
   * the UI can show a provider's own claim differently from a name guess.
   * Optional because catalog entries predate it and a missing claim simply
   * reads as "unknown" rather than "no".
   */
  capabilityClaims?: import('./control.js').CapabilityClaims;
  /** First time Meridian saw this model. Drives the "recently discovered" view. */
  discoveredAt?: number;
  /** Last time a provider listing or probe confirmed it still exists. */
  lastVerifiedAt?: number;
}

/** Quality scores in [0,100]; null when never measured. */
export interface ModelScores {
  modelId: string;
  coding: number | null;
  reasoning: number | null;
  general: number | null;
  toolUse: number | null;
  vision: number | null;
  /** Observed reliability in [0,1] — successes / attempts. */
  stability: number | null;
  /** Number of observations backing these scores. */
  samples: number;
  updatedAt: number;
}

export interface ModelPerformance {
  modelId: string;
  /** Time to first token, ms. */
  ttftMs: number | null;
  /** Mean end-to-end latency, ms. */
  latencyMs: number | null;
  p95LatencyMs: number | null;
  /** Standard deviation of latency, ms — the "jitter" signal. */
  jitterMs: number | null;
  tokensPerSecond: number | null;
  /** Fraction of health checks that succeeded, [0,1]. */
  uptime: number | null;
  samples: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/** Credential scope, ordered by resolution precedence (see CREDENTIAL_SCOPE_ORDER). */
export const CREDENTIAL_SCOPES = [
  'request',
  'user',
  'workspace',
  'admin',
  'system',
  'managed',
  'anonymous',
] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/** Spec §42 resolution order. */
export const CREDENTIAL_SCOPE_ORDER: readonly CredentialScope[] = CREDENTIAL_SCOPES;

/** Where a credential came from. Used to prove it was legitimately obtained. */
export const CREDENTIAL_SOURCES = [
  'user-entered',
  'environment',
  'oauth',
  'admin',
  'local-file',
  'anonymous-endpoint',
] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface CredentialRecord {
  id: string;
  providerId: string;
  scope: CredentialScope;
  source: CredentialSource;
  /** Human label, e.g. "Personal OpenRouter key". Never the secret. */
  label: string;
  /** Owning user id, when scope === 'user'. */
  userId: string | null;
  /** Owning workspace id, when scope === 'workspace'. */
  workspaceId: string | null;
  /** Credential pool membership, if any. */
  poolId: string | null;
  /** Higher wins when several credentials tie. */
  priority: number;
  enabled: boolean;
  /** Last 4 characters only — the full secret never leaves the server. */
  hint: string;
  /** Max simultaneous in-flight requests on this credential. */
  maxConcurrency: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

/** A credential with its decrypted secret. Server-side only — never serialised to a client. */
export interface ResolvedCredential extends CredentialRecord {
  secret: string | null;
}

export interface CredentialPool {
  id: string;
  providerId: string;
  name: string;
  /** How to pick among member credentials. */
  strategy: 'priority' | 'round-robin' | 'least-used' | 'health';
  enabled: boolean;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The complete routing mode set. The first six are the plain-language modes
 * surfaced in the UI (spec §31); the rest are the explicit policies (spec §39).
 */
/**
 * The agent pipelines a caller may ask for by name.
 *
 * Lives here rather than in agent-sdk because the web client needs it too, and
 * agent-sdk is a Node package. It was previously written out as a string-literal
 * union in three separate places — the orchestrator, the gateway route and the
 * web store — so adding a pipeline to one left the other two rejecting it.
 */
export const PIPELINE_KINDS = ['auto', 'research', 'debug', 'tests', 'code', 'browse', 'orchestrate'] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];

export const ROUTING_MODES = [
  'AUTO',
  'BEST',
  'FAST',
  'CHEAP',
  'FREE',
  'LOCAL',
  'FREE_FIRST',
  'CHEAP_FIRST',
  'QUALITY_FIRST',
  'FASTEST',
  'LOCAL_FIRST',
  'USER_FIRST',
  'ADMIN_FIRST',
  'BALANCED',
  'CUSTOM',
] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** Normalised request handed to the router. */
export interface AIRequest {
  modality: Modality;
  taskType: TaskType;
  prompt?: string;
  messages?: ChatMessage[];
  requiredCapabilities?: Capability[];
  /** Pin an exact model id (`provider:model`) or a bare provider model id. */
  model?: string | null;
  /** Pin a provider. */
  provider?: string | null;
  /** Route through a named inference pool. */
  pool?: string | null;
  /** Hard USD ceiling for this request. 0 means "must not spend". */
  budget?: number | null;
  freeOnly?: boolean;
  localOnly?: boolean;
  /** Minimum context window the model must support. */
  contextLength?: number | null;
  toolsRequired?: boolean;
  reasoningRequired?: boolean;
  visionRequired?: boolean;
  mode?: RoutingMode;
  privacyMode?: PrivacyMode;
  /** Identity used for credential resolution and usage accounting. */
  userId?: string | null;
  workspaceId?: string | null;
  /** Marks the payload as sensitive; blocks untrusted providers. */
  sensitive?: boolean;
  /** Explicit permission to spend money on this request. */
  allowPaid?: boolean;
  /**
   * The output ceiling this call will carry, when the caller declared one.
   *
   * Routing does not send it to a provider — the completion request does that.
   * It is here because a budget reservation has to be sized before the call is
   * made, and `maxTokens` is the only ceiling anyone has actually stated. Left
   * unset, the reservation falls back to a conservative default instead.
   */
  maxTokens?: number | null;
}

export interface RoutingCandidate {
  modelId: string;
  providerId: string;
  score: number;
  /** Per-factor contributions, for the routing-explanation panel. */
  factors: Record<string, number>;
  /**
   * USD for this call, or **null when the price is not published**.
   *
   * Null rather than 0: a metered model with no published rate can charge any
   * amount, and reporting that as zero made it the cheapest candidate on every
   * cost-sensitive comparison. Consumers must render null as unknown.
   */
  estimatedCost: number | null;
  /** Which side of the operator's money this route sits on. */
  costClass: CostClass;
  estimatedLatencyMs: number | null;
  free: boolean;
  /**
   * The operator named this model or its provider in their preferences.
   *
   * Distinct from the `preference` factor, which is a weighted nudge that a
   * strong enough score elsewhere can outvote. This is the explicit instruction
   * itself, and ranking honours it ahead of the weighted score.
   */
  preferred?: boolean;
}

export interface RoutingReason {
  /** Short human sentence, e.g. "Best current coding score on a healthy free provider". */
  summary: string;
  /** Checklist rendered in the "Why this model?" panel. */
  criteria: { label: string; met: boolean; detail?: string }[];
  /** Ranked runners-up, for transparency. */
  considered: RoutingCandidate[];
  /** Candidates dropped before scoring, with the rule that dropped them. */
  rejected: { modelId: string; reason: string }[];
  /**
   * The policy the scoring actually ran under.
   *
   * This is not always what the caller asked for: the plain-language modes are
   * aliases (FAST is FASTEST, BEST is QUALITY_FIRST), and choosing a pool
   * overrides the mode entirely. Reporting the applied policy is what makes the
   * scores below explicable.
   */
  mode: RoutingMode;
  /** What the caller asked for, before aliasing and any pool override. */
  requestedMode: RoutingMode;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  /** Credential id; null for genuinely anonymous free endpoints. */
  credential: string | null;
  pool: string | null;
  /** Ordered alternates tried on failure. */
  fallbackChain: { provider: string; model: string; credential: string | null }[];
  routingReason: RoutingReason;
  /**
   * USD. 0 for free and local, and **null when the provider publishes no rate**
   * — which is not the same thing and must not be rendered as `$0.00`.
   */
  expectedCost: number | null;
  /**
   * USD held against a pool's budget for as long as the call is in flight.
   *
   * This is deliberately **not** `expectedCost`. `expectedCost` is a prediction
   * — a mid-range guess used for ranking and for telling the caller what a call
   * is likely to cost. A budget ceiling needs the opposite bias: the amount
   * reserved has to be one the settled cost is unlikely to exceed, because two
   * callers that both read an optimistic estimate can each be admitted and then
   * together bill past the ceiling. So this is priced at the call's output
   * ceiling rather than at a guess about how long the answer will be, and it is
   * returned in full when the call settles, at which point `recordSpend` adds
   * what it actually cost.
   *
   * `null` carries the same meaning as on `expectedCost`: the provider
   * publishes no rate, so nothing can be shown to fit a budget.
   */
  reservationCost: number | null;
  expectedLatency: number | null;
}

/* ------------------------------------------------------------------ */
/* Inference pools and reservations                                    */
/* ------------------------------------------------------------------ */

export interface PoolMember {
  modelId: string;
  /** Higher is preferred. */
  priority: number;
  enabled: boolean;
  /** Optional per-member share of pool concurrency. */
  weight?: number;
}

export interface InferencePool {
  id: string;
  name: string;
  description: string | null;
  /** Which routing policy the pool applies to its members. */
  strategy: RoutingMode;
  members: PoolMember[];
  /** Pool to spill into when every member is unavailable. */
  fallbackPoolId: string | null;
  maxConcurrency: number | null;
  /** USD ceiling per day across the pool. null = unlimited (free pools). */
  dailyBudget: number | null;
  /** Built-in pools cannot be deleted, only edited. */
  builtin: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface Reservation {
  id: string;
  poolId: string;
  label: string;
  startAt: number;
  endAt: number;
  maxConcurrency: number;
  /** USD ceiling for the window. */
  budget: number | null;
  /** Pool used once the reservation's own capacity is exhausted. */
  fallbackPoolId: string | null;
  /** Model ids the reservation is restricted to; empty = all pool members. */
  models: string[];
  status: 'scheduled' | 'active' | 'expired' | 'cancelled';
  /** Requests consumed during the window. */
  used: number;
  spend: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Chat and completion payloads                                        */
/* ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image';
  /** data: URL or https URL. */
  url: string;
  mimeType?: string;
}
export interface AudioPart {
  type: 'audio';
  url: string;
  mimeType?: string;
}
export type ContentPart = TextPart | ImagePart | AudioPart;

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments. Adapters are responsible for parsing provider JSON. */
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  /** Assistant messages may carry tool calls. */
  toolCalls?: ToolCall[];
  /** Tool messages carry the id of the call they answer. */
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

/**
 * How hard a reasoning-capable model should think before answering.
 *
 * These are Meridian's canonical levels; each adapter maps them onto whatever
 * its provider actually accepts — OpenAI's `reasoning_effort`, Anthropic's
 * extended-thinking token budget, and so on. A model without the `reasoning`
 * capability never receives it: the value is dropped in the executor once the
 * concrete model is known, so a chat model is never sent a parameter it would
 * reject.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  stream?: boolean;
  /** How hard a reasoning model should think. Ignored by non-reasoning models. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-specific escape hatch, passed through verbatim. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; schema?: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD, computed from the model's pricing. */
  cost: number;
}

export const FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export interface CompletionResponse {
  id: string;
  model: string;
  providerId: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  /** Wall-clock ms for the whole call. */
  latencyMs: number;
  ttftMs: number | null;
  /** True when the response came from a fallback rather than the first choice. */
  viaFallback: boolean;
  raw?: unknown;
}

export type StreamChunk =
  | { type: 'start'; model: string; providerId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason }
  | { type: 'error'; error: string; code: string };

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export interface ImageRequest {
  model?: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  steps?: number;
  guidance?: number;
  seed?: number | null;
  n?: number;
  style?: string | null;
  /** data: URL for img2img / reference. */
  referenceImage?: string | null;
  signal?: AbortSignal;
}

export interface GeneratedAsset {
  /** data: URL or a path served by the gateway's asset route. */
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSec?: number;
  seed?: number | null;
  bytes?: number;
}

export interface ImageResponse {
  id: string;
  model: string;
  providerId: string;
  assets: GeneratedAsset[];
  latencyMs: number;
  usage: Usage;
}

export interface VideoRequest {
  model?: string;
  prompt: string;
  negativePrompt?: string;
  durationSec?: number;
  fps?: number;
  width?: number;
  height?: number;
  referenceImage?: string | null;
  motion?: number;
  seed?: number | null;
  signal?: AbortSignal;
}

export interface VideoResponse {
  id: string;
  model: string;
  providerId: string;
  assets: GeneratedAsset[];
  latencyMs: number;
  usage: Usage;
  /** Long-running video jobs report progress before completing. */
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: number;
}

export interface SpeechRequest {
  model?: string;
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'flac';
  speed?: number;
  signal?: AbortSignal;
}

export interface SpeechResponse {
  id: string;
  model: string;
  providerId: string;
  asset: GeneratedAsset;
  latencyMs: number;
  usage: Usage;
}

export interface TranscriptionRequest {
  model?: string;
  /** Raw audio bytes. */
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResponse {
  id: string;
  model: string;
  providerId: string;
  text: string;
  language: string | null;
  durationSec: number | null;
  latencyMs: number;
  usage: Usage;
}

export interface EmbeddingRequest {
  model?: string;
  input: string[];
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  id: string;
  model: string;
  providerId: string;
  embeddings: number[][];
  dimensions: number;
  latencyMs: number;
  usage: Usage;
}

/* ------------------------------------------------------------------ */
/* Agents and tasks                                                    */
/* ------------------------------------------------------------------ */

export const AGENT_ROLES = [
  'orchestrator',
  'planner',
  'file-finder',
  'researcher',
  'browser',
  'implementer',
  'tester',
  'reviewer',
  'debugger',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentDefinition {
  role: AgentRole;
  name: string;
  description: string;
  /** Task type used when routing this agent's calls. */
  taskType: TaskType;
  /** Routing mode override, e.g. file-finder prefers FAST + CHEAP. */
  preferredMode: RoutingMode;
  /** Pool this agent draws from by default. */
  pool: string;
  /** Tools the agent may call. */
  tools: string[];
  systemPrompt: string;
  maxSteps: number;
  requiredCapabilities: Capability[];
}

export const TASK_STATUSES = [
  'queued',
  'running',
  'awaiting-input',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface TaskStep {
  id: string;
  taskId: string;
  /** Display label, e.g. "Finding files". */
  label: string;
  role: AgentRole;
  status: StepStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** Concise execution summary — never raw chain-of-thought. */
  summary: string | null;
  modelId: string | null;
  providerId: string | null;
  latencyMs: number | null;
  usage: Usage | null;
  toolCallCount: number;
  filesTouched: string[];
  error: string | null;
  fallbackEvents: FallbackEvent[];
  order: number;
}

export interface FallbackEvent {
  at: number;
  fromProvider: string;
  fromModel: string;
  toProvider: string | null;
  toModel: string | null;
  /** Machine code, e.g. "rate_limited". */
  code: string;
  /** One-sentence user-facing explanation. */
  message: string;
  attempt: number;
}

export interface AgentTask {
  id: string;
  workspaceId: string;
  userId: string | null;
  title: string;
  request: string;
  status: TaskStatus;
  /** Parallel agent lane, e.g. "frontend" / "backend" / "tests". */
  lane: string | null;
  mode: RoutingMode;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** Estimate produced before execution (spec §59). */
  estimate: TaskEstimate | null;
  usage: Usage;
  result: string | null;
}

export interface TaskEstimate {
  calls: number;
  models: number;
  tokens: number;
  seconds: number;
  /**
   * USD across the whole pipeline. When `costKnown` is false this is a floor
   * built from the steps that could be priced, not the expected total.
   */
  cost: number;
  /**
   * True when every step in the plan routes to a model with a published rate.
   *
   * False means at least one step would run on a model whose price nobody
   * publishes, so the total above is a lower bound. Presenting it as the price
   * would be the same mistake as calling an unpriced model free.
   */
  costKnown: boolean;
  strategy: RoutingMode;
  freeAvailable: boolean;
  note: string | null;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  stepId: string | null;
  name: string;
  /** Arguments with secrets redacted. */
  arguments: Record<string, unknown>;
  result: string | null;
  error: string | null;
  durationMs: number;
  at: number;
}

/* ------------------------------------------------------------------ */
/* Workspaces, files, diffs                                            */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: string;
  name: string;
  /**
   * The user this workspace belongs to, or null when it is shared by the whole
   * instance. Workspaces created before ownership existed are shared.
   */
  userId?: string | null;
  /** Absolute path inside the gateway's workspace root. */
  path: string;
  /** Git remote when the workspace was cloned. */
  repoUrl: string | null;
  branch: string | null;
  /** Private workspaces never route to untrusted providers. */
  privacyMode: PrivacyMode;
  defaultMode: RoutingMode;
  createdAt: number;
  lastOpenedAt: number | null;
}

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  children?: FileNode[];
}

export interface FileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
  additions: number;
  deletions: number;
  /** Review state — nothing is written to disk until accepted. */
  state: 'pending' | 'accepted' | 'rejected';
}

/* ------------------------------------------------------------------ */
/* Usage, audit, observability                                         */
/* ------------------------------------------------------------------ */

export interface UsageRecord {
  id: string;
  at: number;
  requestId: string;
  userId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  agentRole: AgentRole | null;
  /**
   * The agent step this call belongs to.
   *
   * Distinct from `agentRole`, and the distinction has teeth: a pipeline can
   * run the same role twice — a failing check appends a repair attempt and
   * re-runs the tester — so matching a verification verdict to usage rows by
   * role applied the second run's result to the first run's calls, crediting a
   * model with a pass it never earned.
   */
  stepId: string | null;
  providerId: string;
  modelId: string;
  credentialId: string | null;
  poolId: string | null;
  modality: Modality;
  taskType: TaskType;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  latencyMs: number;
  ttftMs: number | null;
  success: boolean;
  fallbackCount: number;
  errorCode: string | null;
  /**
   * A compact record of why this attempt went where it did.
   *
   * The full decision is computed on every call and was returned to the caller
   * and then dropped, so "why did this request pick that model" had no answer
   * for anything already finished — including the request that just spent
   * money. Stored per attempt because a fallback re-routes and each attempt has
   * its own answer.
   */
  routing?: RoutingSnapshot | null;
  /** Prompt tokens the context optimiser kept out of this call. */
  contextTokensSaved?: number | null;
}

/**
 * The part of a routing decision worth keeping.
 *
 * Not the whole `RoutingReason`: the considered list can run to dozens of
 * candidates and the rejection list to hundreds, and storing all of it on every
 * attempt would trade a large table for detail nobody reads. What a person
 * actually asks afterwards is which policy applied, what won, what nearly won,
 * and what was ruled out — so that is what is kept.
 */
export interface RoutingSnapshot {
  /** The policy the scoring ran under, after aliasing and any pool override. */
  mode: RoutingMode;
  /** What the caller asked for, before that resolution. */
  requestedMode: RoutingMode;
  summary: string;
  /** The winner and its closest runners-up. */
  considered: { modelId: string; score: number; estimatedCost: number | null; costClass: CostClass }[];
  /** Why the most common rejections happened, with how many each accounted for. */
  rejected: { reason: string; count: number }[];
}

export interface AuditLogEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  /** Details with all secrets redacted before persistence. */
  details: Record<string, unknown>;
  ip: string | null;
}

/* ------------------------------------------------------------------ */
/* Users and access control                                            */
/* ------------------------------------------------------------------ */

export const ROLES = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface UserPreferences {
  userId: string;
  routingMode: RoutingMode;
  privacyMode: PrivacyMode;
  /** Model ids the user prefers, most-preferred first. */
  preferredModels: string[];
  preferredProviders: string[];
  preferredPool: string | null;
  theme: 'light' | 'dark' | 'system';
  reduceMotion: boolean;
  /** Persisted panel sizes and collapse state, keyed by layout slot. */
  layout: Record<string, unknown>;
  allowPaid: boolean;
  maxCostPerTask: number | null;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Generation jobs (image / video / audio queue)                       */
/* ------------------------------------------------------------------ */

export interface GenerationJob {
  id: string;
  userId: string | null;
  workspaceId: string | null;
  modality: Extract<Modality, 'image' | 'video' | 'speech' | 'transcription'>;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt: string;
  params: Record<string, unknown>;
  modelId: string | null;
  providerId: string | null;
  assets: GeneratedAsset[];
  error: string | null;
  progress: number;
  cost: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
