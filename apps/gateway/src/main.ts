import { readFileSync } from 'node:fs';
import { isDesktopRuntime, loadConfig } from '@meridian/shared';
import { App } from './services/app.js';
import { createServer } from './server.js';
import { announcePort, choosePort, clearRuntimeState, installShutdownHandlers, publishRuntimeState } from './desktop.js';

/**
 * Gateway entry point.
 *
 * One process serves the web client, the OpenAI-compatible API, the
 * Anthropic-compatible API, the admin API and the event stream, all on the one
 * documented port. A self-hosted product should be one container and one URL.
 *
 * The same process is also the desktop application's backend, started and
 * stopped by a native shell that the user never sees. That adds three things
 * and changes nothing else: it may have to move off the documented port, it has
 * to say where it ended up, and it has to be stoppable on an operating system
 * with no SIGTERM.
 */

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const desktop = isDesktopRuntime();
  const app = await App.create(config);
  await app.start();

  const server = await createServer(app);

  let stopped = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    app.logger.info('shutting down', { signal });
    // Close the HTTP server first so no new work arrives, then release the
    // database — closing them the other way round drops in-flight writes.
    await server.close().catch(() => undefined);
    await app.stop().catch(() => undefined);
    clearRuntimeState();
    process.exit(0);
  };

  installShutdownHandlers({
    // Only the desktop shell holds our stdin. A container's stdin is closed
    // immediately unless it was started with `-i`, so watching it there would
    // shut the gateway down the instant it finished booting.
    watchStdin: desktop,
    logger: app.logger,
    run: shutdown,
  });

  // A collision on the documented port is a misconfiguration a server operator
  // must see. For a desktop user it is Tuesday — something else on their
  // machine took 4639 years ago — and moving quietly, then saying so, is the
  // only behaviour that does not turn an install into a support ticket.
  const allowFallback = process.env.MERIDIAN_PORT_FALLBACK === '1' || desktop;
  const requested = await choosePort(config.port, config.host, allowFallback);
  await server.listen({ port: requested, host: config.host });

  // What was actually bound, which is the only number worth reporting: with an
  // ephemeral port the request was 0.
  const address = server.server.address();
  const port = address && typeof address !== 'string' ? address.port : config.port;
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;

  const state = {
    pid: process.pid,
    port,
    host: config.host,
    url,
    version: version(),
    startedAt: Date.now(),
    desktop,
  };
  const statePath = publishRuntimeState(state, app.logger);

  app.logger.info('Meridian is ready', {
    url,
    openai: `${url}/v1`,
    anthropic: `${url}/anthropic/v1`,
    models: app.models.size(),
    providers: app.providers.usable().length,
    sandbox: app.sandbox.kind,
    ...(port !== config.port ? { requestedPort: config.port, note: 'the preferred port was busy' } : {}),
    ...(statePath ? { runtimeState: statePath } : {}),
  });
  for (const w of app.warnings) app.logger[w.level === 'warn' ? 'warn' : 'info'](w.message);

  // The machine-readable line, last, so a supervisor that reads until it sees
  // this knows everything above it has already been said.
  if (desktop || process.env.MERIDIAN_ANNOUNCE_PORT === '1') announcePort(state);

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
