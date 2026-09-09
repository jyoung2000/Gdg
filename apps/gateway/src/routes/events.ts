import type { FastifyInstance } from 'fastify';
import { beginSse } from './shared.js';
import type { App } from '../services/app.js';
import type { EventViewer } from '../services/events.js';

/**
 * Live updates.
 *
 * Two transports for one stream: a WebSocket for the app, and SSE for anything
 * that cannot open one (a proxy, a curl pipeline, a terminal dashboard). Both
 * carry the identical {@link ServerEvent} union, so there is one event contract
 * rather than two.
 */
export async function registerEventRoutes(server: FastifyInstance, app: App): Promise<void> {
  /**
   * Who this connection is, for event filtering.
   *
   * An administrator watches the instance, which is what the operator console
   * is for. Everyone else sees the instance's own signals and their own work,
   * and nothing of anybody else's.
   */
  const viewerOf = (req: { auth: { userId: string | null; role: string } }): EventViewer => ({
    userId: req.auth.userId,
    admin: req.auth.role === 'admin',
  });

  server.get('/api/events/ws', { websocket: true }, (socket, req) => {
    const viewer = viewerOf(req);
    // Replay recent events so a client that connects mid-task sees the steps
    // that already happened rather than starting from a blank timeline.
    for (const event of app.events.replay(viewer)) {
      socket.send(JSON.stringify(event));
    }

    const unsubscribe = app.events.subscribe((event) => {
      // readyState 1 is OPEN; sending to a closing socket throws.
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    }, viewer);

    // Some proxies close an idle WebSocket after 30-60s; a periodic ping keeps
    // a quiet connection alive between tasks.
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
    }, 25_000);
    ping.unref?.();

    socket.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
    socket.on('error', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  server.get('/api/events', async (req, reply) => {
    beginSse(reply);

    const write = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const viewer = viewerOf(req);
    for (const event of app.events.replay(viewer)) write(event);

    const unsubscribe = app.events.subscribe(write, viewer);
    const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 25_000);
    heartbeat.unref?.();

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    reply.raw.on('close', close);
    req.raw.on('aborted', close);
  });
}
