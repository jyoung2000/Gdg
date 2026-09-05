import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@meridian/shared';

export type DB = Database.Database;

/** Where the .sql migration files live, whether running from source or a bundle. */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From source: apps/gateway/src/db -> repo root. From a bundle: dist/gateway -> repo root.
  for (const candidate of [
    resolve(here, '../../../../database/migrations'),
    resolve(here, '../../database/migrations'),
    resolve(process.cwd(), 'database/migrations'),
  ]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('Could not locate database/migrations');
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

  db.pragma('journal_mode = WAL');
  // NORMAL is the right durability point for WAL: a crash can lose the last
  // transaction but never corrupts the file, and it removes an fsync per write.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name));

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    // Each migration is one transaction: a partially-applied schema is worse
    // than a failed startup.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      db.exec('COMMIT');
      logger.info('migration applied', { migration: file });
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
