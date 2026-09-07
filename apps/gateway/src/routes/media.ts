import type { FastifyInstance } from 'fastify';
import { MeridianError, type RoutingMode } from '@meridian/shared';
import { ASPECT_RATIOS } from '@meridian/media-sdk';
import type { App } from '../services/app.js';
import { intParam } from './shared.js';
import { requireScope } from './authz.js';

interface GenerateBody {
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  provider?: string;
  pool?: string;
  mode?: RoutingMode;
  width?: number;
  height?: number;
  aspectRatio?: string;
  steps?: number;
  guidance?: number;
  seed?: number | null;
  n?: number;
  style?: string;
  referenceImage?: string;
  allowPaid?: boolean;
  budget?: number;
  freeOnly?: boolean;
  localOnly?: boolean;
  workspaceId?: string;
}

/**
 * Image, video and speech generation.
 *
 * These are jobs, not requests: a video can take minutes and an image can take
 * thirty seconds, so the route returns a queued job immediately and progress
 * arrives on the event stream. That also means a browser refresh never loses a
 * generation that is already running.
 */
export async function registerMediaRoutes(server: FastifyInstance, app: App): Promise<void> {
  /**
   * Whether this caller may see this job. Single-user instances have nothing to
   * hide; on a shared one a generation is the prompt its owner typed, which is
   * exactly the kind of thing users assume other users cannot read. The failure
   * mode is a 404, never a 403 — a distinguishable refusal is an enumeration
   * oracle over other people's job ids.
   */
  const visible = (req: { auth: { userId: string | null; role: string } }, job: { userId: string | null }): boolean => {
    if (!app.config.authRequired) return true;
    if (req.auth.role === 'admin') return true;
    return job.userId != null && job.userId === req.auth.userId;
  };

  server.get<{ Querystring: { limit?: string } }>('/api/generations', async (req) => ({
    jobs: app.media.listJobs(intParam(req.query?.limit, 60, 300)).filter((j) => visible(req, j)),
    aspectRatios: Object.keys(ASPECT_RATIOS),
  }));

  server.get<{ Params: { id: string } }>('/api/generations/:id', async (req) => {
    const job = app.media.get(req.params.id) ?? app.store.getGenerationJob(req.params.id);
    if (!job || !visible(req, job)) throw new MeridianError('invalid_request', 'No such generation job');
    return { job };
  });

  server.post<{ Params: { id: string } }>('/api/generations/:id/cancel', async (req) => {
    const job = app.media.get(req.params.id) ?? app.store.getGenerationJob(req.params.id);
    if (!job || !visible(req, job)) throw new MeridianError('invalid_request', 'No such generation job');
    return { cancelled: app.media.cancel(req.params.id) };
  });

  server.post<{ Body: GenerateBody }>('/api/generations/image', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    requireScope(req, 'inference');
    const body = req.body ?? {};
    if (!body.prompt) throw new MeridianError('invalid_request', '"prompt" is required');
    const prefs = app.preferencesFor(req.auth.userId);

    const job = await app.media.generateImage(
      {
        prompt: body.prompt,
        negativePrompt: body.negativePrompt,
        width: body.width,
        height: body.height,
        aspectRatio: body.aspectRatio,
        steps: body.steps,
        guidance: body.guidance,
        seed: body.seed ?? null,
        n: Math.min(body.n ?? 1, 4),
        style: body.style ?? null,
        referenceImage: body.referenceImage ?? null,
      },
      {
        userId: req.auth.userId,
        workspaceId: body.workspaceId ?? null,
        model: body.model ?? null,
        provider: body.provider ?? null,
        pool: body.pool ?? 'image',
        mode: body.mode,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
        budget: body.budget ?? prefs.maxCostPerTask,
        freeOnly: body.freeOnly,
        localOnly: body.localOnly,
        privacyMode: prefs.privacyMode,
      },
    );
    return { job };
  });

  server.post<{ Body: GenerateBody & { durationSec?: number; fps?: number; motion?: number } }>('/api/generations/video', { bodyLimit: app.config.maxBodyBytes }, async (req) => {
    requireScope(req, 'inference');
    const body = req.body ?? {};
    if (!body.prompt) throw new MeridianError('invalid_request', '"prompt" is required');
    const prefs = app.preferencesFor(req.auth.userId);

    const job = await app.media.generateVideo(
      {
        prompt: body.prompt,
        negativePrompt: body.negativePrompt,
        durationSec: body.durationSec,
        fps: body.fps,
        width: body.width,
        height: body.height,
        referenceImage: body.referenceImage ?? null,
        motion: body.motion,
        seed: body.seed ?? null,
      },
      {
        userId: req.auth.userId,
        workspaceId: body.workspaceId ?? null,
        model: body.model ?? null,
        provider: body.provider ?? null,
        pool: body.pool ?? 'video',
        mode: body.mode,
        allowPaid: body.allowPaid ?? prefs.allowPaid,
        budget: body.budget ?? prefs.maxCostPerTask,
        freeOnly: body.freeOnly,
        localOnly: body.localOnly,
        privacyMode: prefs.privacyMode,
      },
    );
    return { job };
  });

  server.post<{ Body: { text?: string; voice?: string; format?: 'mp3' | 'wav' | 'opus' | 'flac'; speed?: number; model?: string; allowPaid?: boolean } }>(
    '/api/generations/speech', { bodyLimit: app.config.maxBodyBytes },
    async (req) => {
      requireScope(req, 'inference');
      const body = req.body ?? {};
      if (!body.text) throw new MeridianError('invalid_request', '"text" is required');
      const prefs = app.preferencesFor(req.auth.userId);
      const job = await app.media.synthesizeSpeech(
        { text: body.text, voice: body.voice, format: body.format, speed: body.speed },
        {
          userId: req.auth.userId,
          model: body.model ?? null,
          allowPaid: body.allowPaid ?? prefs.allowPaid,
          privacyMode: prefs.privacyMode,
        },
      );
      return { job };
    },
  );

  server.post<{ Body: { audio?: string; mimeType?: string; language?: string; model?: string; allowPaid?: boolean } }>(
    '/api/generations/transcribe', { bodyLimit: app.config.maxBodyBytes },
    async (req) => {
      requireScope(req, 'inference');
      const body = req.body ?? {};
      if (!body.audio) throw new MeridianError('invalid_request', '"audio" must be base64-encoded audio or a data: URL');
      const raw = body.audio.startsWith('data:') ? body.audio.slice(body.audio.indexOf(',') + 1) : body.audio;
      const prefs = app.preferencesFor(req.auth.userId);

      const result = await app.media.transcribe(
        { audio: new Uint8Array(Buffer.from(raw, 'base64')), mimeType: body.mimeType ?? 'audio/mpeg', language: body.language },
        { userId: req.auth.userId, model: body.model ?? null, allowPaid: body.allowPaid ?? prefs.allowPaid, privacyMode: prefs.privacyMode },
      );
      return result;
    },
  );
}
