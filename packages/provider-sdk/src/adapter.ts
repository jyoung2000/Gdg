import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
  ModelDescriptor,
  ProviderDescriptor,
  SpeechRequest,
  SpeechResponse,
  StreamChunk,
  TranscriptionRequest,
  TranscriptionResponse,
  VideoRequest,
  VideoResponse,
} from '@meridian/shared';
import type { Logger } from '@meridian/shared';

/** Everything an adapter needs to make one call on behalf of one caller. */
export interface AdapterContext {
  /** Decrypted secret for this call, or null for anonymous endpoints. */
  secret: string | null;
  /** Overrides the descriptor's base URL — used for local endpoints and tests. */
  baseUrl?: string;
  logger: Logger;
  requestId: string;
  /** Per-call timeout. Adapters must honour it. */
  timeoutMs: number;
  /**
   * How long a stream may go without a byte before it is treated as stalled.
   *
   * Separate from `timeoutMs` because a long generation is not a stalled one:
   * the deadline that matters mid-stream is silence, not total duration.
   */
  streamIdleTimeoutMs?: number;
  signal?: AbortSignal;
  /** Extra headers merged last, e.g. provider-specific attribution headers. */
  headers?: Record<string, string>;
}

/**
 * One provider integration.
 *
 * Every method is optional except {@link ProviderAdapter.capabilities} and the
 * descriptor: a provider implements only the modalities it genuinely serves,
 * and the router will never select it for a modality it does not declare. This
 * is what makes "no fake support" enforceable rather than aspirational — a
 * provider without an `image` method cannot be routed image work.
 */
export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;

  /** Which of the optional methods are actually implemented. */
  capabilities(): AdapterCapabilities;

  /** Live model discovery. Omitted when the provider publishes no listing API. */
  listModels?(ctx: AdapterContext): Promise<ModelDescriptor[]>;

  /** Cheap liveness probe. Should not consume paid quota where avoidable. */
  healthCheck?(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;

  chat?(req: CompletionRequest, ctx: AdapterContext): Promise<CompletionResponse>;
  chatStream?(req: CompletionRequest, ctx: AdapterContext): AsyncIterable<StreamChunk>;
  embed?(req: EmbeddingRequest, ctx: AdapterContext): Promise<EmbeddingResponse>;
  image?(req: ImageRequest, ctx: AdapterContext): Promise<ImageResponse>;
  video?(req: VideoRequest, ctx: AdapterContext): Promise<VideoResponse>;
  speech?(req: SpeechRequest, ctx: AdapterContext): Promise<SpeechResponse>;
  transcribe?(req: TranscriptionRequest, ctx: AdapterContext): Promise<TranscriptionResponse>;
}

export interface AdapterCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  embedding: boolean;
  image: boolean;
  video: boolean;
  speech: boolean;
  transcription: boolean;
  discovery: boolean;
  health: boolean;
}

export const NO_CAPABILITIES: AdapterCapabilities = {
  chat: false,
  streaming: false,
  tools: false,
  vision: false,
  embedding: false,
  image: false,
  video: false,
  speech: false,
  transcription: false,
  discovery: false,
  health: false,
};

/** Derive the capability set from which methods an adapter actually defines. */
export function inferCapabilities(
  adapter: Partial<ProviderAdapter>,
  overrides: Partial<AdapterCapabilities> = {},
): AdapterCapabilities {
  return {
    ...NO_CAPABILITIES,
    chat: typeof adapter.chat === 'function',
    streaming: typeof adapter.chatStream === 'function',
    embedding: typeof adapter.embed === 'function',
    image: typeof adapter.image === 'function',
    video: typeof adapter.video === 'function',
    speech: typeof adapter.speech === 'function',
    transcription: typeof adapter.transcribe === 'function',
    discovery: typeof adapter.listModels === 'function',
    health: typeof adapter.healthCheck === 'function',
    ...overrides,
  };
}
