import {
  MeridianError,
  newId,
  type AIRequest,
  type GeneratedAsset,
  type GenerationJob,
  type ImageRequest,
  type Logger,
  type PrivacyMode,
  type RoutingMode,
  type SpeechRequest,
  type TranscriptionRequest,
  type VideoRequest,
} from '@meridian/shared';
import type { Executor } from '@meridian/routing-sdk';

export interface MediaDeps {
  executor: Executor;
  logger: Logger;
  /** Persist a job on every state change so the UI survives a reload. */
  persist?: (job: GenerationJob) => void;
  onUpdate?: (job: GenerationJob) => void;
  /** Writes an asset to disk and returns the URL the gateway serves it from. */
  storeAsset?: (jobId: string, index: number, asset: GeneratedAsset) => Promise<GeneratedAsset>;
  now?: () => number;
}

export interface GenerateOptions {
  userId?: string | null;
  workspaceId?: string | null;
  model?: string | null;
  provider?: string | null;
  pool?: string | null;
  mode?: RoutingMode;
  privacyMode?: PrivacyMode;
  allowPaid?: boolean;
  budget?: number | null;
  signal?: AbortSignal;
}

/** Common aspect ratios, resolved to pixel dimensions on a 64px grid. */
export const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
  '3:2': { width: 1216, height: 832 },
  '2:3': { width: 832, height: 1216 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '21:9': { width: 1536, height: 640 },
};

export function resolveDimensions(req: { width?: number; height?: number; aspectRatio?: string }): { width: number; height: number } {
  if (req.width && req.height) return { width: req.width, height: req.height };
  if (req.aspectRatio && ASPECT_RATIOS[req.aspectRatio]) return ASPECT_RATIOS[req.aspectRatio];
  return ASPECT_RATIOS['1:1'];
}

/**
 * The media engine.
 *
 * Image, video, speech and transcription all route through the same engine and
 * the same {@link Executor}, so they inherit routing, pools, fallback, health
 * and cost accounting without a second implementation of any of it. What
 * differs per modality is only the request shape and how long it takes.
 */
export class MediaEngine {
  private readonly deps: MediaDeps;
  private readonly now: () => number;
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(deps: MediaDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get(jobId: string): GenerationJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  cancel(jobId: string): boolean {
    const ac = this.aborts.get(jobId);
    if (!ac) return false;
    ac.abort(new Error('cancelled'));
    const job = this.jobs.get(jobId);
    if (job) this.update({ ...job, status: 'cancelled', finishedAt: this.now() });
    return true;
  }

  /**
   * Start an image generation and return the queued job immediately.
   *
   * Generation is slow enough that a synchronous API would tie up a request for
   * tens of seconds, so the job is the unit the client polls or subscribes to.
   */
  async generateImage(req: ImageRequest, opts: GenerateOptions = {}): Promise<GenerationJob> {
    const { width, height } = resolveDimensions(req);
    const job = this.begin('image', req.prompt, {
      ...req,
      width,
      height,
      referenceImage: req.referenceImage ? '[reference image supplied]' : null,
    }, opts);

    void this.execute(job.id, opts, async (ac) => {
      const res = await this.deps.executor.image(
        this.aiRequest('image', 'image-generation', req.prompt, opts),
        { ...req, width, height, signal: ac.signal },
        { signal: ac.signal, timeoutMs: 180_000 },
      );
      return { assets: res.value.assets, cost: res.value.usage.cost, modelId: res.modelId, providerId: res.providerId };
    });

    return job;
  }

  async generateVideo(req: VideoRequest, opts: GenerateOptions = {}): Promise<GenerationJob> {
    const { width, height } = resolveDimensions(req);
    const job = this.begin('video', req.prompt, { ...req, width, height }, opts);

    void this.execute(job.id, opts, async (ac) => {
      const res = await this.deps.executor.video(
        this.aiRequest('video', 'video-generation', req.prompt, opts),
        { ...req, width, height, signal: ac.signal },
        // Video routinely takes minutes; a chat-length timeout would abandon
        // work that was about to succeed.
        { signal: ac.signal, timeoutMs: 900_000 },
      );
      return { assets: res.value.assets, cost: res.value.usage.cost, modelId: res.modelId, providerId: res.providerId };
    });

    return job;
  }

  async synthesizeSpeech(req: SpeechRequest, opts: GenerateOptions = {}): Promise<GenerationJob> {
    const job = this.begin('speech', req.text, { voice: req.voice, format: req.format, speed: req.speed }, opts);

    void this.execute(job.id, opts, async (ac) => {
      const res = await this.deps.executor.speech(
        this.aiRequest('speech', 'speech-synthesis', req.text, opts),
        { ...req, signal: ac.signal },
        { signal: ac.signal, timeoutMs: 120_000 },
      );
      return { assets: [res.value.asset], cost: res.value.usage.cost, modelId: res.modelId, providerId: res.providerId };
    });

    return job;
  }

  /** Transcription returns text rather than an asset, so it resolves directly. */
  async transcribe(req: TranscriptionRequest, opts: GenerateOptions = {}): Promise<{ text: string; language: string | null; modelId: string; providerId: string; cost: number }> {
    const res = await this.deps.executor.transcribe(
      this.aiRequest('transcription', 'transcription', '', opts),
      req,
      { signal: opts.signal, timeoutMs: 300_000 },
    );
    return {
      text: res.value.text,
      language: res.value.language,
      modelId: res.modelId,
      providerId: res.providerId,
      cost: res.value.usage.cost,
    };
  }

  listJobs(limit = 50): GenerationJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Rehydrate jobs from the database at startup. */
  load(jobs: GenerationJob[]): void {
    for (const j of jobs) {
      // A job that was running when the process died did not survive it.
      this.jobs.set(j.id, j.status === 'running' || j.status === 'queued' ? { ...j, status: 'failed', error: 'Interrupted by a gateway restart' } : j);
    }
  }

  /* ---------------------------------------------------------------- */

  private aiRequest(modality: AIRequest['modality'], taskType: AIRequest['taskType'], prompt: string, opts: GenerateOptions): AIRequest {
    return {
      modality,
      taskType,
      prompt,
      model: opts.model ?? null,
      provider: opts.provider ?? null,
      pool: opts.pool ?? defaultPoolFor(modality),
      mode: opts.mode,
      privacyMode: opts.privacyMode,
      userId: opts.userId ?? null,
      workspaceId: opts.workspaceId ?? null,
      allowPaid: opts.allowPaid,
      budget: opts.budget ?? null,
    };
  }

  private begin(
    modality: GenerationJob['modality'],
    prompt: string,
    params: Record<string, unknown>,
    opts: GenerateOptions,
  ): GenerationJob {
    const job: GenerationJob = {
      id: newId('gen'),
      userId: opts.userId ?? null,
      workspaceId: opts.workspaceId ?? null,
      modality,
      status: 'queued',
      prompt,
      params,
      modelId: null,
      providerId: null,
      assets: [],
      error: null,
      progress: 0,
      cost: 0,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    this.deps.persist?.(job);
    this.deps.onUpdate?.(job);
    return job;
  }

  private async execute(
    jobId: string,
    opts: GenerateOptions,
    work: (ac: AbortController) => Promise<{ assets: GeneratedAsset[]; cost: number; modelId: string; providerId: string }>,
  ): Promise<void> {
    const ac = new AbortController();
    if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(opts.signal?.reason), { once: true });
    this.aborts.set(jobId, ac);

    const job = this.jobs.get(jobId);
    if (!job) return;
    this.update({ ...job, status: 'running', startedAt: this.now(), progress: 0.05 });

    try {
      const out = await work(ac);
      // Data URLs are convenient but enormous; storing the bytes and serving a
      // path keeps the job list from carrying megabytes of base64 per row.
      const stored = this.deps.storeAsset
        ? await Promise.all(out.assets.map((a, i) => this.deps.storeAsset!(jobId, i, a)))
        : out.assets;
      const current = this.jobs.get(jobId);
      if (!current || current.status === 'cancelled') return;
      this.update({
        ...current,
        status: 'completed',
        assets: stored,
        cost: out.cost,
        modelId: out.modelId,
        providerId: out.providerId,
        progress: 1,
        finishedAt: this.now(),
      });
    } catch (e) {
      const current = this.jobs.get(jobId);
      if (!current || current.status === 'cancelled') return;
      const message = e instanceof MeridianError ? e.message : e instanceof Error ? e.message : String(e);
      this.deps.logger.warn('generation failed', { errorCode: message });
      this.update({ ...current, status: 'failed', error: message, finishedAt: this.now(), progress: 0 });
    } finally {
      this.aborts.delete(jobId);
    }
  }

  private update(job: GenerationJob): void {
    this.jobs.set(job.id, job);
    this.deps.persist?.(job);
    this.deps.onUpdate?.(job);
  }
}

function defaultPoolFor(modality: AIRequest['modality']): string | null {
  switch (modality) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    default:
      return null;
  }
}

/** Decode a data: URL into bytes so an asset can be written to disk. */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mimeType: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return {
    mimeType: m[1],
    bytes: m[2] ? new Uint8Array(Buffer.from(m[3], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[3])),
  };
}

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
  };
  return map[mimeType] ?? 'bin';
}
