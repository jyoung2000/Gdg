import { AsyncLocalStorage } from 'node:async_hooks';
import { MeridianError, classifyStatus, classifyUnknown, readRateLimitHeaders, snapshotIsEmpty } from '@meridian/shared';
import type { ErrorCode, RateLimitSnapshot } from '@meridian/shared';

/**
 * Where a rate-limit reading goes when one is seen.
 *
 * Providers publish an account's remaining allowance in response headers, on
 * ordinary successful responses — the one place the information exists, and the
 * one place nothing was reading. Getting it out of here and onto the account it
 * belongs to needed a channel from sixty-odd adapter call sites back to the
 * executor.
 *
 * Threading a callback through every one of them would have been sixty-odd
 * chances to forget one, and a forgotten site is silent: the quota simply never
 * updates for that provider. An async-local store means the executor states once
 * that it is interested, every call underneath it is covered whether or not its
 * adapter was written with this in mind, and an adapter called outside an
 * execution — a probe, a listing — sees no store and does nothing.
 */
const rateLimitSink = new AsyncLocalStorage<(snapshot: RateLimitSnapshot) => void>();

/** Run `fn` with rate-limit headers from any HTTP call inside it reported to `sink`. */
export function withRateLimitSink<T>(sink: (snapshot: RateLimitSnapshot) => void, fn: () => T): T {
  return rateLimitSink.run(sink, fn);
}

/**
 * Report what a response said about the account's allowance.
 *
 * Never throws into the request path: a malformed header is not a reason to
 * fail a call that succeeded.
 */
function reportRateLimit(headers: Headers): void {
  const sink = rateLimitSink.getStore();
  if (!sink) return;
  try {
    const snapshot = readRateLimitHeaders(headers, Date.now());
    if (!snapshotIsEmpty(snapshot)) sink(snapshot);
  } catch {
    /* Observability must never break the thing it observes. */
  }
}

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
  return coreRequest(url, opts, null) as Promise<Response>;
}

/**
 * How much of a JSON body will be buffered before the connection is cut.
 *
 * Large is deliberate — image generations arrive as base64 inside JSON — but
 * bounded is the point: a provider (or an interposed box) that streams garbage
 * forever must cost a failed request, not the gateway's memory.
 */
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;

async function coreRequest(url: string, opts: HttpOptions, consume: 'text' | null): Promise<Response | { body: string }> {
  // An already-cancelled caller gets no request at all. AbortSignal fires its
  // event only on the transition, so a listener added after the fact never
  // fires and the dispatch below would proceed un-cancellable.
  if (opts.signal?.aborted) {
    throw new MeridianError('cancelled', 'Request cancelled before dispatch', {
      providerId: opts.providerId,
      modelId: opts.modelId ?? null,
    });
  }

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
    // Read before the status check: a 429 carries the most useful quota
    // headers there are, and returning early would throw them away.
    reportRateLimit(res.headers);
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
    if (consume === null) return res;

    // The body is read while the deadline and the caller's cancel still apply.
    // Returning the Response and reading it in the caller looked equivalent,
    // but the finally below had already cleared the timer and unhooked the
    // parent signal — so a provider that sent headers and then trickled the
    // body held the connection forever, immune to both timeout and cancel.
    return { body: await readBodyCapped(res, MAX_JSON_BODY_BYTES, opts) };
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
  const { body } = (await coreRequest(url, opts, 'text')) as { body: string };
  try {
    return JSON.parse(body) as T;
  } catch {
    // A 2xx wrapped around something that is not JSON is a provider-side
    // malfunction (or an interposed proxy page). Left unclassified it escaped
    // as a raw SyntaxError, was labelled `internal`, and aborted the whole
    // fallback chain for what is exactly the failure the chain exists for.
    throw new MeridianError('server_error', `Provider returned a 2xx response whose body is not JSON`, {
      providerId: opts.providerId,
      modelId: opts.modelId ?? null,
      details: { body: body.slice(0, 300) },
    });
  }
}

async function readBodyCapped(res: Response, maxBytes: number, opts: HttpOptions): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MeridianError('server_error', `Response body exceeded ${Math.round(maxBytes / 1_048_576)}MB`, {
          providerId: opts.providerId,
          modelId: opts.modelId ?? null,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
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
