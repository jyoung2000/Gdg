import { MeridianError, classifyStatus, classifyUnknown } from '@meridian/shared';
import type { ErrorCode } from '@meridian/shared';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body, used for multipart uploads. */
  rawBody?: BodyInit;
  timeoutMs: number;
  signal?: AbortSignal;
  providerId: string;
  modelId?: string | null;
}

/** Parse Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(headers: Headers, now: number): number | null {
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-after');
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return Math.max(0, Math.round(asNumber));
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, Math.round((asDate - now) / 1000));
  return null;
}

/**
 * One HTTP call with a hard deadline, uniform error classification and no
 * retries. Retry and failover are the fallback engine's job, not the
 * adapter's — keeping them in one place is what makes the retry budget real.
 */
export async function httpRequest(url: string, opts: HttpOptions): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onParentAbort = (): void => ac.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const init: RequestInit = {
      method: opts.method ?? 'POST',
      headers: opts.headers,
      signal: ac.signal,
    };
    if (opts.rawBody !== undefined) init.body = opts.rawBody;
    else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code: ErrorCode = classifyStatus(res.status, text);
      throw new MeridianError(code, describeHttpError(res.status, text), {
        providerId: opts.providerId,
        modelId: opts.modelId ?? null,
        retryAfterSec: parseRetryAfter(res.headers, Date.now()),
        details: { status: res.status, body: text.slice(0, 800) },
      });
    }
    return res;
  } catch (e) {
    if (e instanceof MeridianError) throw e;
    if (opts.signal?.aborted) {
      throw new MeridianError('cancelled', 'Request cancelled', { providerId: opts.providerId, modelId: opts.modelId ?? null });
    }
    if (ac.signal.aborted) {
      throw new MeridianError('timeout', `Request to ${opts.providerId} timed out after ${opts.timeoutMs}ms`, {
        providerId: opts.providerId,
        modelId: opts.modelId ?? null,
      });
    }
    throw classifyUnknown(e, opts.providerId, opts.modelId ?? undefined);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Extract the most useful message a provider gave us, without dumping HTML. */
function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const err = parsed.error ?? parsed.detail ?? parsed.message ?? parsed;
      if (typeof err === 'string') return `HTTP ${status}: ${err}`;
      if (err && typeof err === 'object') {
        const m = (err as Record<string, unknown>).message;
        if (typeof m === 'string') return `HTTP ${status}: ${m}`;
      }
    } catch {
      /* fall through to the truncated body */
    }
  }
  const oneLine = trimmed.replace(/\s+/g, ' ').slice(0, 240);
  return oneLine ? `HTTP ${status}: ${oneLine}` : `HTTP ${status}`;
}

export async function httpJson<T>(url: string, opts: HttpOptions): Promise<T> {
  const res = await httpRequest(url, opts);
  return (await res.json()) as T;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /**
   * Longest gap allowed between chunks before the stream is abandoned.
   *
   * A total deadline is the wrong tool for a stream: a long generation is not a
   * stalled one. What actually distinguishes a hung provider is silence, so the
   * budget resets on every chunk received.
   */
  idleTimeoutMs?: number;
  providerId?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * Iterate a `text/event-stream` body, yielding each `data:` payload.
 * Stops on the `[DONE]` sentinel used by OpenAI-compatible providers.
 *
 * Reading is bounded on two axes because `httpRequest`'s deadline necessarily
 * ends when the headers arrive — a streaming response has barely started at
 * that point. Cancelling the reader is what actually tears down the underlying
 * connection; merely checking a flag between reads cannot interrupt a read that
 * never returns.
 */
export async function* sseLines(
  res: Response,
  signalOrOptions?: AbortSignal | StreamOptions,
): AsyncGenerator<string> {
  const opts: StreamOptions =
    signalOrOptions && 'idleTimeoutMs' in signalOrOptions ? signalOrOptions : { signal: signalOrOptions as AbortSignal | undefined };
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const signal = opts.signal;

  const body = res.body;
  if (!body) throw new MeridianError('server_error', 'Streaming response had no body', { providerId: opts.providerId ?? null });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Cancelling the reader is what unblocks a pending read, so an abort must
  // both cancel and record itself: cancellation resolves the in-flight read as
  // `{done: true}`, which is indistinguishable from a clean end of stream
  // unless the flag is checked afterwards.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted || aborted) throw new MeridianError('cancelled', 'Stream cancelled', { providerId: opts.providerId ?? null });

      let idleTimer: NodeJS.Timeout | undefined;
      // The idle timer only rejects; it deliberately does not cancel the
      // reader, because cancelling would resolve the pending read first and
      // win the race, turning a stall into a silent, successful end of stream.
      // The reader is torn down by this function's own finally block instead.
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          reject(
            new MeridianError('timeout', `Stream stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`, {
              providerId: opts.providerId ?? null,
            }),
          );
        }, idleTimeoutMs);
        idleTimer.unref?.();
      });

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }

      if (aborted || signal?.aborted) {
        throw new MeridianError('cancelled', 'Stream cancelled', { providerId: opts.providerId ?? null });
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // SSE events are separated by a blank line; handle both LF and CRLF.
      let sep: number;
      while ((sep = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const data = rawEvent
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        yield data;
      }
    }
    // Flush a trailing event that arrived without its blank-line terminator.
    const tail = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (tail && tail !== '[DONE]') yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Base64 helpers used by the media adapters. */
export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export function fromDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mimeType = m[1];
  const isBase64 = Boolean(m[2]);
  const payload = m[3];
  return {
    mimeType,
    bytes: isBase64 ? new Uint8Array(Buffer.from(payload, 'base64')) : new TextEncoder().encode(decodeURIComponent(payload)),
  };
}
