import type { FastifyInstance } from 'fastify';
import { MeridianError, type RoutingMode } from '@meridian/shared';
import { ASPECT_RATIOS } from '@meridian/media-sdk';
import type { App } from '../services/app.js';
import { intParam } from './shared.js';

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
  server.get<{ Querystring: { limit?: string } }>('/api/generations', async (req) => ({
    jobs: app.media.listJobs(intParam(req.query?.limit, 60, 300)),
    aspectRatios: Object.keys(ASPECT_RATIOS),
  }));

  server.get<{ Params: { id: string } }>('/api/generations/:id', async (req) => {
    const job = app.media.get(req.params.id) ?? app.store.getGenerationJob(req.params.id);
    if (!job) throw new MeridianError('invalid_request', 'No such generation job');
    return { job };
  });

  server.post<{ Params: { id: string } }>('/api/generations/:id/cancel', async (req) => ({
    cancelled: app.media.cancel(req.params.id),
  }));

  server.post<{ Body: GenerateBody }>('/api/generations/image', async (req) => {
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
        privacyMode: prefs.privacyMode,
      },
    );
    return { job };
  });

  server.post<{ Body: GenerateBody & { durationSec?: number; fps?: number; motion?: number } }>('/api/generations/video', async (req) => {
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
        privacyMode: prefs.privacyMode,
      },
    );
    return { job };
  });

  server.post<{ Body: { text?: string; voice?: string; format?: 'mp3' | 'wav' | 'opus' | 'flac'; speed?: number; model?: string; allowPaid?: boolean } }>(
    '/api/generations/speech',
    async (req) => {
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
    '/api/generations/transcribe',
    async (req) => {
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
