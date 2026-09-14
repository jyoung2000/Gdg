import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { nullLogger } from '@meridian/shared';
import { openDatabase } from '../../apps/gateway/src/db/database.js';

/**
 * Upgrading an installation that already has data in it.
 *
 * Every migration test that existed checked that a *new* database ends up with
 * the right schema, which is the case nobody upgrades into. The interesting
 * path is the one a real operator takes: a database written by last release,
 * full of their credentials and their history, opened by this one. Nothing
 * covered it, so nothing would have caught a migration that dropped a table it
 * meant to rename, or an upgrade that silently ran twice.
 *
 * These build a genuine previous-release database — the real migration files,
 * up to a cut-off, with real rows written through them — and then open it with
 * the current build.
 */
describe('Database upgrades', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MIGRATIONS = resolve(HERE, '../../database/migrations');
  const ALL = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  const withDirAsync = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-migrate-'));
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const withDir = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-migrate-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** A migrations directory holding only the first `count` real migrations. */
  const partialMigrations = (dir: string, count: number): string => {
    const sub = join(dir, `migrations-${count}`);
    mkdirSync(sub, { recursive: true });
    for (const f of ALL.slice(0, count)) copyFileSync(join(MIGRATIONS, f), join(sub, f));
    return sub;
  };

  /** Open with a specific migrations directory, restoring the env afterwards. */
  const openWith = (path: string, migrationsDir: string | null): Database.Database => {
    const previous = process.env.MERIDIAN_MIGRATIONS_DIR;
    if (migrationsDir) process.env.MERIDIAN_MIGRATIONS_DIR = migrationsDir;
    else delete process.env.MERIDIAN_MIGRATIONS_DIR;
    try {
      return openDatabase(path, nullLogger);
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_MIGRATIONS_DIR;
      else process.env.MERIDIAN_MIGRATIONS_DIR = previous;
    }
  };

  it('carries a previous release’s data forward', () => {
    withDir((dir) => {
      const path = join(dir, 'upgrade.db');

      // An installation on an older release: the same migration files this
      // repository shipped, stopping one short of the current set.
      const old = openWith(path, partialMigrations(dir, ALL.length - 1));
      old
        .prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
        .run('usr_old', 'operator@example.com', 'Operator', 'admin', 1000);
      old
        .prepare(
          'INSERT INTO workspaces (id, name, path, repo_url, branch, privacy_mode, default_mode, created_at, last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run('ws_old', 'Their project', '/tmp/theirs', null, null, 'ANY_PROVIDER', 'AUTO', 1000, null);
      const appliedBefore = old.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
      assert.equal(appliedBefore.n, ALL.length - 1, 'the fixture must really be one release behind');
      old.close();

      // The upgrade: this build, that database.
      const upgraded = openWith(path, MIGRATIONS);
      try {
        const user = upgraded.prepare('SELECT email FROM users WHERE id = ?').get('usr_old') as { email: string };
        assert.equal(user.email, 'operator@example.com', 'an upgrade must not lose the operator');
        const ws = upgraded.prepare('SELECT name FROM workspaces WHERE id = ?').get('ws_old') as { name: string };
        assert.equal(ws.name, 'Their project', 'or their work');

        const after = upgraded.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
        assert.equal(after.n, ALL.length, 'every migration must now be recorded');
        // And the newest migration's schema is genuinely present, not merely
        // recorded as applied.
        assert.doesNotThrow(
          () => upgraded.prepare('SELECT scope, provider_id FROM discovery_schedule').all(),
          'the newest table must exist after the upgrade',
        );
      } finally {
        upgraded.close();
      }
    });
  });

  it('upgrades from an empty installation in one go', () => {
    withDir((dir) => {
      const path = join(dir, 'fresh.db');
      const db = openWith(path, MIGRATIONS);
      try {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
        assert.equal(n, ALL.length);
      } finally {
        db.close();
      }
      // Re-opening applies nothing and breaks nothing: the ordinary restart.
      const again = openWith(path, MIGRATIONS);
      try {
        const n = (again.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
        assert.equal(n, ALL.length, 'a restart must not re-apply or double-record anything');
      } finally {
        again.close();
      }
    });
  });

  it('fails closed on a broken migration, leaving the database as it was', () => {
    withDir((dir) => {
      const path = join(dir, 'broken.db');
      const good = partialMigrations(dir, ALL.length);
      const broken = join(dir, 'migrations-broken');
      mkdirSync(broken, { recursive: true });
      for (const f of ALL) copyFileSync(join(MIGRATIONS, f), join(broken, f));
      // Sorts after every real migration, so everything before it is valid.
      writeFileSync(join(broken, '999_broken.sql'), 'CREATE TABLE oops (id TEXT REFERENCES nothing_at_all(id));\nSELECT this_is_not_sql(;\n');

      assert.throws(
        () => openWith(path, broken),
        (e: Error) => {
          assert.match(e.message, /999_broken\.sql failed/, `the error must name the file, got: ${e.message}`);
          assert.match(e.message, /left exactly as it was/, 'and say the database was not half-changed');
          return true;
        },
        'a broken migration must stop startup rather than leave a partial schema',
      );

      // Nothing from the failed upgrade survived: not the table it managed to
      // create before dying, and not a record claiming it was applied.
      const raw = new Database(path);
      try {
        const names = (raw.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name);
        assert.ok(!names.includes('999_broken.sql'), 'a failed migration must not be recorded as applied');
        assert.equal(names.length, 0, 'and the whole upgrade rolls back together, not just the file that broke');
        const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oops'").all() as unknown[]).length;
        assert.equal(tables, 0, 'nor may it leave the table it created behind');
      } finally {
        raw.close();
      }

      // And once the bad file is gone, the same database upgrades cleanly —
      // the failure was fatal to the startup, not to the installation.
      const recovered = openWith(path, good);
      try {
        const n = (recovered.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
        assert.equal(n, ALL.length);
      } finally {
        recovered.close();
      }
    });
  });

  it('refuses to run an older build against a newer database', () => {
    withDir((dir) => {
      const path = join(dir, 'ahead.db');
      // A newer release: every migration this build has, plus one it does not.
      const newer = join(dir, 'migrations-newer');
      mkdirSync(newer, { recursive: true });
      for (const f of ALL) copyFileSync(join(MIGRATIONS, f), join(newer, f));
      writeFileSync(join(newer, '900_from_the_future.sql'), 'CREATE TABLE IF NOT EXISTS future_feature (id TEXT PRIMARY KEY);\n');
      openWith(path, newer).close();

      // Now the older build — this one — opens it. SQLite would happily
      // proceed, reading tables that have moved and writing rows the newer
      // build cannot use. Silently, which is the whole problem.
      assert.throws(
        () => openWith(path, MIGRATIONS),
        (e: Error) => {
          assert.match(e.message, /newer version of Meridian/, `got: ${e.message}`);
          assert.match(e.message, /900_from_the_future\.sql/, 'the error must name what it does not recognise');
          return true;
        },
        'an older build must refuse a newer database rather than corrupt it quietly',
      );
    });
  });

  it('lets two processes start at once without a spurious migration failure', async () => {
    await withDirAsync(async (dir) => {
      // Two real processes, released into openDatabase at the same instant
      // against the same empty database. Both read an empty _migrations, both
      // try to apply everything, and the loser used to die on a primary-key
      // conflict inside _migrations — a startup crash whose message blamed the
      // migration rather than the race. A Compose file with two replicas, or a
      // desktop app double-clicked twice, is exactly this.
      //
      // The barrier matters: migrations take milliseconds and process startup
      // takes the best part of a second, so two processes merely spawned
      // together almost never overlap. Without it the test passes whatever the
      // code does, which is worse than not having it.
      // A migrations directory whose last file takes real time to apply. With
      // only the genuine migrations the window between "read _migrations" and
      // "write _migrations" is under a millisecond, and two processes almost
      // never land inside it — so the test would pass whatever the code did,
      // which is worse than not having it.
      const slowDir = join(dir, 'migrations-slow');
      mkdirSync(slowDir, { recursive: true });
      for (const f of ALL) copyFileSync(join(MIGRATIONS, f), join(slowDir, f));
      writeFileSync(
        join(slowDir, 'zzz_slow.sql'),
        [
          'CREATE TABLE IF NOT EXISTS slow_fixture (n INTEGER PRIMARY KEY);',
          'INSERT INTO slow_fixture (n)',
          '  WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 200000)',
          '  SELECT n FROM counter;',
          'DROP TABLE slow_fixture;',
        ].join('\n'),
      );
      const expected = ALL.length + 1;

      const script = join(dir, 'open.ts');
      writeFileSync(
        script,
        [
          `import { existsSync, writeFileSync } from 'node:fs';`,
          `import { nullLogger } from '${resolve(HERE, '../../packages/shared/src/index.ts')}';`,
          `import { openDatabase } from '${resolve(HERE, '../../apps/gateway/src/db/database.js')}';`,
          `const [dbPath, barrier] = process.argv.slice(2);`,
          `writeFileSync(barrier + '.' + String(process.pid) + '.ready', '1');`,
          `// Spin, deliberately: a timer would hand the other process a head start.`,
          `while (!existsSync(barrier + '.go')) { /* wait for the release */ }`,
          `const db = openDatabase(dbPath, nullLogger);`,
          `const n = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;`,
          `db.close();`,
          `process.stdout.write(String(n));`,
        ].join('\n'),
      );

      const race = async (round: number): Promise<void> => {
        const dbPath = join(dir, `race-${round}.db`);
        const barrier = join(dir, `barrier-${round}`);
        const runs = [0, 1].map(
          () =>
            new Promise<{ code: number | null; out: string; err: string }>((done) => {
              const child = spawn(process.execPath, ['--import', 'tsx', script, dbPath, barrier], {
                cwd: resolve(HERE, '../..'),
                env: { ...process.env, MERIDIAN_MIGRATIONS_DIR: slowDir },
              });
              let out = '';
              let err = '';
              child.stdout.on('data', (c: Buffer) => (out += c.toString()));
              child.stderr.on('data', (c: Buffer) => (err += c.toString()));
              child.on('close', (code) => done({ code, out, err }));
            }),
        );

        // Release them only once both are parked on the barrier.
        const ready = async (): Promise<void> => {
          for (let i = 0; i < 600; i++) {
            const waiting = readdirSync(dir).filter((f) => f.startsWith(`barrier-${round}.`) && f.endsWith('.ready'));
            if (waiting.length >= 2) return;
            await new Promise((r) => {
              const t = setTimeout(r, 50);
              t.unref?.();
            });
          }
          throw new Error('the two processes never both reached the barrier');
        };
        await ready();
        writeFileSync(`${barrier}.go`, '1');

        const results = await Promise.all(runs);
        for (const [i, result] of results.entries()) {
          assert.equal(
            result.code,
            0,
            `round ${round}, process ${i} must start cleanly, got exit ${result.code}: ${result.err.slice(0, 400)}`,
          );
          assert.equal(
            result.out,
            String(expected),
            `round ${round}, process ${i} must see every migration applied exactly once, got ${result.out}`,
          );
        }
      };

      // Three rounds on fresh databases: one lucky interleaving proves nothing.
      for (let round = 0; round < 3; round++) await race(round);
    });
  });
});
