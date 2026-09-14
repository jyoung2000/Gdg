import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@meridian/shared';

export type DB = Database.Database;

/**
 * Where the .sql migration files live, whether running from source, from a
 * bundle in a checkout, or from an installed application.
 *
 * The three layouts differ in what is *above* the bundle. In a checkout there
 * is a repository root two or four levels up. In an installed desktop
 * application there is no repository at all: the payload is
 * `server/gateway/main.js` beside `server/database/migrations`, dropped inside
 * an installation directory whose parents belong to the operating system.
 *
 * `MERIDIAN_MIGRATIONS_DIR` exists for the same reason `MERIDIAN_WEB_ROOT`
 * does: an installer knows exactly where it put things and should be able to
 * say so rather than rely on a search finding it.
 */
function migrationsDir(): string {
  const configured = process.env.MERIDIAN_MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    configured,
    // From source: apps/gateway/src/db -> repo root. From a bundle in a
    // checkout: dist/gateway -> repo root.
    resolve(here, '../../../../database/migrations'),
    resolve(here, '../../database/migrations'),
    // Beside the bundle, which is how a packaged application ships them: the
    // payload is self-contained and has nothing above it worth searching.
    resolve(here, 'database/migrations'),
    resolve(here, '../database/migrations'),
    resolve(process.cwd(), 'database/migrations'),
  ]) {
    if (!candidate) continue;
    try {
      // A directory that exists but holds no migrations is not the one we
      // want, and finding it would leave the schema empty rather than fail.
      if (readdirSync(candidate).some((f) => f.endsWith('.sql'))) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    'Could not locate database/migrations. Set MERIDIAN_MIGRATIONS_DIR to the directory holding the .sql files.',
  );
}

/**
 * Sleep, synchronously, because better-sqlite3 is synchronous.
 *
 * There is nothing to await: the whole database layer runs to completion on
 * the calling thread, and a promise here would just return to an event loop
 * that has nothing else to do during startup.
 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Put the database into WAL mode, waiting out another process that is doing
 * the same thing.
 *
 * `PRAGMA journal_mode = WAL` needs an exclusive lock and — unlike ordinary
 * statements — does *not* go through SQLite's busy handler: it returns
 * "database is locked" immediately, however generous `busy_timeout` is. So two
 * gateways starting together had the loser die on the first line of the
 * database layer, before it had done anything at all, with an error that
 * named no file and suggested no cause.
 *
 * Re-reading the mode each time is what makes this terminate quickly in the
 * ordinary case: the winner sets WAL once, and every subsequent process finds
 * it already set and never asks for the lock.
 */
function ensureWal(db: DB, attempts = 100, waitMs = 50): void {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    if (String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase() === 'wal') return;
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (e) {
      // Only a lock is worth waiting out. A read-only file or a corrupt header
      // will never resolve, and retrying it for five seconds helps nobody.
      if (!/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
      lastError = e;
      pause(waitMs);
    }
  }
  throw new Error(
    `Could not put the database into WAL mode: another process has held it locked for ${Math.round((attempts * waitMs) / 1000)}s. ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Names already recorded as applied. */
function appliedMigrations(db: DB): Set<string> {
  return new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name));
}

/**
 * How long to wait for another process that is mid-upgrade.
 *
 * Well above the ordinary busy timeout, because the thing being waited for is
 * a schema change rather than a row write. Two gateways started together — a
 * Compose file bringing up two replicas, a desktop app the user double-clicked
 * twice, a restart racing its own predecessor — must queue, not collide.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * Apply every pending migration, as one transaction, under a write lock.
 *
 * One transaction for the whole upgrade rather than one per file: a schema
 * half way between two releases is worse than a failed startup, and the files
 * in a single upgrade are not independent of each other.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front. Without it two processes
 * both read an empty `_migrations`, both apply the same file, and the loser
 * dies on a primary-key conflict — a startup crash whose message blames the
 * migration rather than the race. With it the second process waits, then finds
 * the work already done and applies nothing.
 */
function applyPending(db: DB, dir: string, files: string[], logger: Logger): void {
  db.exec('BEGIN IMMEDIATE');
  const done: string[] = [];
  // Named outside the try so the error can say which file actually broke,
  // rather than guessing from what did not finish.
  let current = 'unknown';
  try {
    // Re-read inside the lock. What was pending a moment ago may have been
    // applied by the process we just queued behind.
    const applied = appliedMigrations(db);
    for (const file of files) {
      if (applied.has(file)) continue;
      current = file;
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      done.push(file);
    }
    db.exec('COMMIT');
  } catch (e) {
    // Fail closed. A rollback that itself fails must not mask the real cause.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction is already gone; the original error is what matters */
    }
    throw new Error(
      `Migration ${current} failed, so the database was left exactly as it was: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Logged after the commit, so nothing claims a migration that rolled back.
  for (const file of done) logger.info('migration applied', { migration: file });
}

/**
 * Open the database and bring it up to date.
 *
 * Migrations are plain .sql files applied in filename order and recorded in
 * `_migrations`, so a restart is idempotent and a Docker volume survives an
 * upgrade with its data intact.
 */
export function openDatabase(path: string, logger: Logger): DB {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);

  // Generous from the first statement: every lock below can be held by another
  // gateway that is mid-upgrade, and a startup that gives up in five seconds
  // turns a normal restart race into a crash.
  db.pragma(`busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  ensureWal(db);
  // NORMAL is the right durability point for WAL: a crash can lose the last
  // transaction but never corrupts the file, and it removes an fsync per write.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const before = appliedMigrations(db);

  /**
   * Refuse to run against a database a newer build made — before touching it.
   *
   * SQLite will happily open it, and every query against a table this build
   * still recognises will appear to work — which is the problem. An older
   * gateway against a newer schema reads columns that have moved, ignores ones
   * it does not know about, and writes rows the newer build cannot make sense
   * of. The damage is silent and accumulates, and the usual way to arrive here
   * is a rollback after a bad upgrade, when the data matters most.
   *
   * The order matters and used to be the other way round. If this build also
   * has a migration the newer database lacks — a renamed file, a hotfix
   * applied out of band, two branches that both used 012 — the upgrade ran
   * first and wrote into a schema it did not understand, and only then
   * announced that it should not have opened the database at all.
   */
  const unknown = [...before].filter((name) => !files.includes(name)).sort();
  if (unknown.length) {
    db.close();
    throw new Error(
      `This database was written by a newer version of Meridian. It records ${unknown.length} migration(s) this build does not have ` +
        `(${unknown.join(', ')}), so the schema is ahead of the code. Refusing to open it without applying anything: running an older ` +
        `build against a newer database corrupts data quietly rather than loudly. Upgrade Meridian to a version that includes those ` +
        `migrations, or restore a backup taken before the upgrade.`,
    );
  }

  // Only take a write lock when there is something to do. A gateway starting
  // against an up-to-date database should not queue behind one that is
  // mid-upgrade.
  if (files.some((f) => !before.has(f))) applyPending(db, dir, files, logger);

  // The long timeout exists for the upgrade, which is over. Ordinary row
  // contention should surface as an error in seconds, not be absorbed for half
  // a minute while a request hangs.
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Parse a JSON column, falling back rather than throwing on corrupt data. */
export function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const bool = (v: unknown): boolean => v === 1 || v === true;
export const int = (v: boolean): number => (v ? 1 : 0);
