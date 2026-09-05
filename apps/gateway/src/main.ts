import { loadConfig } from '@meridian/shared';
import { App } from './services/app.js';
import { createServer } from './server.js';

/**
 * Gateway entry point.
 *
 * One process serves the web client, the OpenAI-compatible API, the
 * Anthropic-compatible API, the admin API and the event stream, all on the one
 * documented port. A self-hosted product should be one container and one URL.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await App.create(config);
  await app.start();

  const server = await createServer(app);

  const shutdown = async (signal: string): Promise<void> => {
    app.logger.info('shutting down', { signal });
    // Close the HTTP server first so no new work arrives, then release the
    // database — closing them the other way round drops in-flight writes.
    await server.close().catch(() => undefined);
    await app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await server.listen({ port: config.port, host: config.host });

  const url = `http://localhost:${config.port}`;
  app.logger.info('Meridian is ready', {
    url,
    openai: `${url}/v1`,
    anthropic: `${url}/anthropic/v1`,
    models: app.models.size(),
    providers: app.providers.usable().length,
    sandbox: app.sandbox.kind,
  });
  for (const w of app.warnings) app.logger[w.level === 'warn' ? 'warn' : 'info'](w.message);

  if (config.logFormat === 'pretty') {
    process.stdout.write(`\n  Meridian — Universal AI Gateway\n  ${url}\n\n`);
  }
}

main().catch((e: unknown) => {
  // Startup failures must be loud and readable: this is the one place a raw
  // stack trace is more useful than a structured log line.
  process.stderr.write(`Meridian failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
