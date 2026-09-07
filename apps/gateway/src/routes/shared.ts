import type { FastifyReply } from 'fastify';
import { MeridianError, ROUTING_MODES } from '@meridian/shared';
import { DEFAULT_PORT as PORT, type RoutingMode } from '@meridian/shared';

export const DEFAULT_PORT = PORT;

/**
 * The six modes surfaced as the primary control. The rest are the explicit
 * policies, shown behind "Advanced" — presenting fifteen equal choices would
 * make the common case harder, not more powerful.
 */
export const MODE_DESCRIPTION_KEYS: RoutingMode[] = ['AUTO', 'BEST', 'FAST', 'CHEAP', 'FREE', 'LOCAL'];

/** Parse a positive integer query parameter, with a bound and a default. */
export function intParam(raw: unknown, dflt: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

/**
 * Start a server-sent-event response, keeping the headers Fastify already set.
 *
 * Writing to `reply.raw` bypasses Fastify's own header serialisation and its
 * `onSend` hooks, so anything the request hooks accumulated — the security
 * headers, the request id, the idempotency disposition — is silently dropped
 * unless it is carried over here. A streamed response is not a place to have
 * weaker headers than a buffered one.
 */
export function beginSse(reply: FastifyReply, extra: Record<string, string> = {}): void {
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string | number | string[]>),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx buffers SSE by default, which turns a live stream into one late blob.
    'x-accel-buffering': 'no',
    ...extra,
  });
}


/**
 * Refuse an unknown routing mode rather than silently treating it as AUTO.
 *
 * `--mode local` degrading to AUTO is worse than an error: the caller asked for
 * a privacy-relevant constraint and got a shrug. Case is forgiven — the CLI and
 * humans write `fast`; the vocabulary is uppercase — but a value outside the
 * vocabulary is a mistake the caller needs to hear about.
 */
export function normalizeMode(raw: unknown): RoutingMode | undefined {
  if (raw == null || raw === '') return undefined;
  const candidate = String(raw).toUpperCase();
  if ((ROUTING_MODES as readonly string[]).includes(candidate)) return candidate as RoutingMode;
  throw new MeridianError('invalid_request', `Unknown routing mode "${String(raw)}". One of: ${ROUTING_MODES.join(', ')}`);
}
