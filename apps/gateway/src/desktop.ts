import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeStatePath, type Logger, type RuntimeState } from '@meridian/shared';

/**
 * The parts of the gateway that exist because something else owns its
 * lifecycle.
 *
 * A container starts the gateway with a fixed port, stops it with SIGTERM, and
 * knows where it is because it published the port itself. A desktop shell has
 * none of those: the port may already be taken by something the user installed
 * years ago, Windows has no SIGTERM, and the CLI has no way to guess where a
 * dynamically-bound instance ended up.
 *
 * Nothing here changes how the gateway behaves as a server. It is all opt-in
 * through the environment, and the container path is untouched.
 */

/**
 * Is this TCP port free on this host, right now?
 *
 * Answered by binding it, because that is the only question that matters and
 * every other method answers a different one. Checking a connect() only proves
 * nothing is *listening*, which is not the same as being able to bind — a
 * socket in TIME_WAIT, or one held with SO_EXCLUSIVEADDRUSE by another Windows
 * process, refuses a bind while refusing connections too.
 */
export function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    // `exclusive` so this mirrors what Fastify's listen will actually attempt.
    probe.listen({ port, host, exclusive: true });
  });
}

/**
 * Pick the port to bind.
 *
 * The preferred port wins whenever it can, because a stable, documented port is
 * worth a great deal to everything outside this process — a bookmark, a CLI
 * default, an `OPENAI_BASE_URL` in someone's shell profile. Moving off it is a
 * last resort, not a convenience.
 *
 * Without `allowFallback` this returns the preferred port regardless and lets
 * the bind fail loudly. That is right for a container, where a port collision
 * is a misconfiguration the operator must see rather than something to paper
 * over by moving the service somewhere they did not ask for.
 */
export async function choosePort(preferred: number, host: string, allowFallback: boolean): Promise<number> {
  if (!allowFallback) return preferred;
  if (await portIsFree(preferred, host)) return preferred;
  // 0 asks the OS for an ephemeral port. Doing it here rather than passing 0
  // through to `listen` means the caller learns the number before binding and
  // can put it in the environment for anything it spawns.
  return 0;
}

/**
 * Tell whatever started us where we ended up.
 *
 * One line, on stdout, parseable without a JSON parser being wrong about
 * anything else the process logs. A desktop shell that chose the port can still
 * be wrong about it: between "this port is free" and "the gateway bound it",
 * another process can take it, and the fallback above will then have moved.
 * This line is how the shell finds out, and it is why the shell must read it
 * rather than assume.
 */
export function announcePort(state: RuntimeState): void {
  process.stdout.write(`${READY_LINE_PREFIX}${JSON.stringify(state)}\n`);
}

/** The marker a supervising process greps for. Stable, and part of the contract. */
export const READY_LINE_PREFIX = 'meridian-ready ';

/**
 * Publish where this instance is listening, for tools that were not started by
 * whoever started it.
 *
 * `uag` defaults to the documented port, and on a desktop install the gateway
 * may not be there. Rather than making every user discover and pass a port, a
 * running instance leaves a note.
 *
 * The note carries a pid, a port and a version: everything in it is already
 * visible to anyone who can list local sockets. Nothing in it is a credential,
 * and that is a constraint on what may ever be added, not an accident of what
 * is here today — a discovery file that carried a token would be a secret
 * sitting at a predictable path with no access control worth the name.
 */
export function publishRuntimeState(state: RuntimeState, logger: Logger): string | null {
  const path = runtimeStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 0o600 on POSIX. Windows ignores the mode and inherits the parent ACL,
    // which for a per-user AppData directory is already the right answer.
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch (e) {
    // Never fatal. Not being able to publish where we are is a lost
    // convenience; refusing to start over it would be a lost product.
    logger.warn('could not publish the runtime state file', { path, detail: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function clearRuntimeState(): void {
  try {
    rmSync(runtimeStatePath(), { force: true });
  } catch {
    /* A stale note is tidied by the next instance; failing to remove one is not worth a word. */
  }
}

export interface ShutdownOptions {
  /**
   * Also shut down when stdin closes.
   *
   * This is the orphan guarantee. A desktop shell holds the child's stdin open
   * for exactly as long as it is alive; if the shell crashes or is killed, the
   * pipe closes and the gateway winds itself down instead of surviving as an
   * invisible process still holding the database and the port. There is no
   * signal on Windows that would deliver that.
   */
  watchStdin: boolean;
  logger: Logger;
  run: (reason: string) => Promise<void>;
}

/**
 * Install every way this process can be asked to stop.
 *
 * Windows is the reason this is not just two signal handlers. It has no
 * SIGTERM: a parent that wants a child gone calls TerminateProcess, which is
 * `kill -9` with no handler and no chance to close the database cleanly. The
 * line protocol on stdin gives a supervising process a way to ask politely, on
 * every platform, with no port and no authentication to get wrong.
 */
export function installShutdownHandlers(opts: ShutdownOptions): void {
  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    void opts.run(reason);
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  if (!opts.watchStdin) return;

  // Resuming stdin keeps the event loop alive on the pipe, which is what makes
  // the close event arrive at all.
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let buffered = '';
  process.stdin.on('data', (chunk: string) => {
    buffered += chunk;
    let index = buffered.indexOf('\n');
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line === 'shutdown') stop('stdin:shutdown');
      index = buffered.indexOf('\n');
    }
  });
  process.stdin.on('close', () => stop('stdin:closed'));
  process.stdin.on('end', () => stop('stdin:end'));
  process.stdin.on('error', () => stop('stdin:error'));
}
