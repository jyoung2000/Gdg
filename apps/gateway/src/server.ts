import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { MeridianError, isMeridianError, redact } from '@meridian/shared';
import type { App } from './services/app.js';
import { registerOpenAIRoutes } from './routes/openai.js';
import { registerAnthropicRoutes } from './routes/anthropic.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerEventRoutes } from './routes/events.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerMcpServerEndpoint } from './routes/mcp-server.js';
import { registerDockerRoutes } from './routes/docker.js';
import { registerGitRoutes } from './routes/git.js';
import { registerControlPlaneRoutes } from './routes/control-plane.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Identity resolved from the API key or session, null when anonymous. */
    auth: { userId: string | null; role: import('@meridian/shared').Role; scopes: string[]; via: 'api-key' | 'anonymous' };
    requestId: string;
    /** Set when this request claimed an Idempotency-Key and still owes a result. */
    idempotency?: { key: string; userId: string; method: string; path: string };
  }
}

/**
 * Hash every inline <script> in the shell so the CSP can allow exactly those
 * and nothing else.
 *
 * The client needs one inline script — it applies the stored theme before first
 * paint, which is the only way to avoid a flash of the wrong theme. Allowing
 * 'unsafe-inline' to accommodate it would defeat the point of having a policy;
 * hashing it keeps script-src strict while letting that one script run, and
 * recomputing at startup means editing the script cannot silently break it.
 */
function inlineScriptHashes(webRoot: string | null): string[] {
  if (!webRoot) return [];
  try {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
    const hashes: string[] = [];
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

/** Locate the built web client, whether running from source or a bundle. */
function findWebRoot(configured: string | null): string | null {
  const candidates = [
    configured,
    resolve(process.cwd(), 'apps/web/dist'),
    resolve(process.cwd(), 'dist/web'),
    resolve(process.cwd(), 'web'),
  ].filter((c): c is string => Boolean(c));
  // Resolved to absolute: @fastify/static rejects a relative root, and the
  // configured value routinely arrives relative from an env file.
  const found = candidates.map((c) => resolve(c)).find((c) => existsSync(resolve(c, 'index.html')));
  return found ?? null;
}

export async function createServer(app: App): Promise<FastifyInstance> {
  const webRoot = findWebRoot(app.config.webRoot);
  const scriptHashes = inlineScriptHashes(webRoot);
  const csp =
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(' ')}` : ''}; ` +
    "connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

  const server = Fastify({
    logger: false, // Meridian has its own structured, redacting logger.
    trustProxy: app.config.trustProxy,
    // The default for every route. Only the handful that carry media — a vision
    // request's image, audio to transcribe — raise it, individually, to
    // MERIDIAN_MAX_BODY_MB. A single large global limit would let any admin or
    // workspace route be used to push tens of megabytes into memory.
    bodyLimit: 2 * 1024 * 1024,
  });

  /* ---- Cross-cutting -------------------------------------------- */

  if (app.config.corsOrigins.length) {
    await server.register(fastifyCors, { origin: app.config.corsOrigins, credentials: true });
  }
  await server.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  server.addHook('onRequest', async (req, reply) => {
    req.requestId = app.newRequestId();
    reply.header('x-request-id', req.requestId);

    // The UI is same-origin and loads no third-party code, so a strict policy
    // costs nothing and closes off script injection through model output.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('content-security-policy', csp);
  });

  /* ---- Rate limiting -------------------------------------------- */

  const buckets = new Map<string, { count: number; resetAt: number }>();
  server.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1') && !req.url.startsWith('/anthropic')) return;
    const key = clientKey(req);
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > app.config.rateLimitPerMinute) {
      reply
        .code(429)
        .header('retry-after', String(Math.ceil((bucket.resetAt - now) / 1000)))
        .send(new MeridianError('rate_limited', 'Too many requests to this gateway. Slow down or raise MERIDIAN_RATE_LIMIT.').toResponse());
    }
  });
  // Unbounded bucket maps are a slow memory leak on a long-lived gateway.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }, 60_000);
  sweeper.unref?.();
  server.addHook('onClose', async () => clearInterval(sweeper));

  /* ---- Authentication -------------------------------------------- */

  server.addHook('onRequest', async (req, reply) => {
    // Least privilege until something establishes otherwise.
    req.auth = { userId: null, role: 'viewer', scopes: [], via: 'anonymous' };

    const header = req.headers.authorization ?? '';
    const xApiKey = req.headers['x-api-key'];
    const presented =
      header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : typeof xApiKey === 'string'
          ? xApiKey
          : null;

    if (presented) {
      const verified = app.store.verifyApiKey(presented);
      if (verified) {
        // The key carries the scopes; the user record carries the role. A key
        // cannot promote its holder, and a role cannot widen a narrow key.
        const user = verified.userId ? app.store.getUser(verified.userId) : null;
        req.auth = { userId: verified.userId, role: user?.role ?? 'member', scopes: verified.scopes, via: 'api-key' };
        return;
      }
      if (app.config.authRequired) {
        reply.code(401).send(new MeridianError('authentication_failed', 'Invalid API key').toResponse());
        return;
      }
    }

    // With auth off, the instance is single-user: requests act as the operator,
    // so preferences, credentials and usage still attribute correctly, and there
    // is nobody to withhold administration from. Turning authentication on is
    // what makes "somebody else" a concept at all.
    if (!app.config.authRequired) {
      const operator = app.store.listUsers()[0];
      req.auth = { userId: operator?.id ?? null, role: operator?.role ?? 'admin', scopes: ['*'], via: 'anonymous' };
      return;
    }

    if (isPublicPath(req.url)) return;
    reply.code(401).send(new MeridianError('authentication_failed', 'This gateway requires an API key').toResponse());
  });

  /* ---- Idempotency ------------------------------------------------ */

  // Retention for idempotency records. Long enough to cover any realistic
  // client retry, short enough that the table does not grow without bound.
  const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Replay a mutating request rather than repeating it.
   *
   * A network timeout tells the client nothing about whether the server acted.
   * Without this, the safe move — retrying — is the one that charges twice or
   * starts a second agent task. Opt-in per request via the `Idempotency-Key`
   * header, which is the convention every provider SDK already speaks.
   */
  server.addHook('preHandler', async (req, reply) => {
    const header = req.headers['idempotency-key'];
    if (typeof header !== 'string' || !header.trim()) return;
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return;

    const body = req.body as Record<string, unknown> | undefined;
    // A streamed response is bytes on a socket, not a value that can be stored
    // and handed back. Saying so beats silently pretending the key was honoured.
    if (body && typeof body === 'object' && body.stream === true) {
      reply.header('x-idempotency', 'not-applied-to-streaming');
      return;
    }

    const key = header.trim().slice(0, 255);
    const path = req.url.split('?')[0];
    // With auth off every request is the operator, so the scope is the instance
    // rather than a user — still correct, just coarser.
    const userId = req.auth.userId ?? 'anonymous';
    const bodyHash = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');
    const claim = app.store.claimIdempotency({ key, userId, method: req.method, path, bodyHash });

    if (claim.state === 'complete') {
      reply.header('x-idempotency', 'replayed').code(claim.status).type('application/json').send(claim.response);
      return reply;
    }
    if (claim.state === 'in_flight') {
      reply
        .header('x-idempotency', 'in-flight')
        .code(409)
        .send(
          new MeridianError(
            'invalid_request',
            'A request with this Idempotency-Key is still running. Wait for it to finish rather than starting a second one.',
          ).toResponse(),
        );
      return reply;
    }
    if (claim.state === 'conflict') {
      reply
        .header('x-idempotency', 'conflict')
        .code(422)
        .send(
          new MeridianError(
            'invalid_request',
            'This Idempotency-Key was already used with a different request body. Use a new key for a different request.',
          ).toResponse(),
        );
      return reply;
    }

    req.idempotency = { key, userId, method: req.method, path };
    reply.header('x-idempotency', 'stored');
  });

  server.addHook('onSend', async (req, reply, payload) => {
    const claim = req.idempotency;
    if (!claim) return payload;
    req.idempotency = undefined;

    // Only a completed, materialised body can be replayed. Anything else — a
    // stream, a file handle, an error — releases the claim so a retry is free to
    // try again rather than being told a duplicate is in flight forever.
    const storable = typeof payload === 'string' || Buffer.isBuffer(payload);
    if (!storable || reply.statusCode >= 500) {
      app.store.releaseIdempotency(claim);
      return payload;
    }
    app.store.completeIdempotency(claim, reply.statusCode, payload.toString());
    return payload;
  });

  const idempotencySweeper = setInterval(() => {
    try {
      app.store.pruneIdempotency(IDEMPOTENCY_TTL_MS);
    } catch (e) {
      app.logger.warn('idempotency prune failed', { errorCode: e instanceof Error ? e.message : String(e) });
    }
  }, 60 * 60 * 1000);
  idempotencySweeper.unref?.();
  server.addHook('onClose', async () => clearInterval(idempotencySweeper));

  /* ---- Errors ----------------------------------------------------- */

  server.setErrorHandler((error: unknown, req, reply) => {
    if (isMeridianError(error)) {
      app.logger.warn('request failed', {
        requestId: req.requestId,
        errorCode: error.code,
        providerId: error.providerId,
        path: req.url,
      });
      reply.code(error.status).send(error.toResponse());
      return;
    }
    const status = typeof (error as { statusCode?: number })?.statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    app.logger.error('unhandled error', { requestId: req.requestId, path: req.url, detail: redact(message) });
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'internal' : 'invalid_request',
        // Internal messages can carry paths and stack detail; clients get a
        // stable sentence and the request id to quote.
        message: status >= 500 ? `Internal error. Request id ${req.requestId}` : redact(message),
        provider: null,
        model: null,
      },
    });
  });

  /* ---- Routes ----------------------------------------------------- */

  await registerSystemRoutes(server, app);
  await registerOpenAIRoutes(server, app);
  await registerAnthropicRoutes(server, app);
  await registerAdminRoutes(server, app);
  await registerWorkspaceRoutes(server, app);
  await registerMediaRoutes(server, app);
  await registerEventRoutes(server, app);
  await registerBrowserRoutes(server, app);
  await registerMcpRoutes(server, app);
  await registerMcpServerEndpoint(server, app);
  await registerDockerRoutes(server, app);
  await registerGitRoutes(server, app);
  await registerControlPlaneRoutes(server, app);

  /* ---- Static assets and the web client --------------------------- */

  // Generated media lives under /media/, not /assets/: Vite emits the web
  // bundle into /assets/, and two static roots on one prefix resolve by
  // registration order — which silently breaks the moment a rebuild changes a
  // bundle filename.
  const assetRoot = resolve(app.config.assetRoot);
  await server.register(fastifyStatic, {
    root: assetRoot,
    prefix: '/media/',
    decorateReply: false,
    // Generated media is immutable: its filename contains the job id.
    cacheControl: true,
    maxAge: '7d',
  });

  if (webRoot) {
    await server.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'], wildcard: false });
    app.logger.info('serving web client', { webRoot });
  } else {
    app.logger.warn('web client not found; API only', { hint: 'run pnpm build to produce dist/web' });
  }

  // One not-found handler: an unmatched API path is an error, and anything else
  // is a client-side route that must return the SPA shell so a deep link works
  // on a hard refresh.
  const apiPath = (url: string): boolean =>
    url.startsWith('/v1') || url.startsWith('/anthropic') || url.startsWith('/api') || url.startsWith('/media') || url.startsWith('/mcp');
  server.setNotFoundHandler((req, reply) => {
    if (!webRoot || req.method !== 'GET' || apiPath(req.url)) {
      reply.code(404).send({ error: { code: 'invalid_request', message: `No route for ${req.method} ${req.url}`, provider: null, model: null } });
      return;
    }
    reply.sendFile('index.html');
  });

  return server;
}

function clientKey(req: FastifyRequest): string {
  const header = req.headers.authorization ?? (req.headers['x-api-key'] as string | undefined) ?? '';
  // Bucket by credential where one is presented, by IP otherwise. Hashing the
  // key would be pointless here — the value never leaves this process — but
  // the raw value must never reach a log, so only its tail is used.
  return header ? `k:${header.slice(-12)}` : `i:${req.ip}`;
}

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0];
  // Probes and the first-run experience.
  if (path === '/api/system/info' || path === '/api/system/health' || path === '/api/system/ready') return true;
  // Generated assets are capability URLs: unguessable job-id filenames, loaded
  // by <img> tags that cannot carry an Authorization header. Documented in
  // docs/SECURITY.md rather than pretended otherwise.
  if (path.startsWith('/media/')) return true;
  // The inference surfaces are exactly what "require an API key" is for —
  // they are where money is spent and where prompts travel. `!startsWith('/api')`
  // used to leave both of them anonymous on an instance that asked for auth.
  if (path.startsWith('/v1') || path.startsWith('/anthropic')) return false;
  // Meridian's own MCP endpoint routes inference; it authenticates like /v1.
  if (path === '/mcp' || path.startsWith('/mcp/')) return false;
  if (path.startsWith('/api')) return false;
  // What remains is the web client's shell and static assets.
  return true;
}

export type { FastifyInstance, FastifyReply, FastifyRequest };
