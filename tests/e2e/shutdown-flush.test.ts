import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, nullLogger } from '@meridian/shared';
import { DiscoveryScheduler } from '@meridian/control-sdk';
import { App } from '../../apps/gateway/src/services/app.js';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';
import { schedulePersistence } from '../../apps/gateway/src/services/schedule-store.js';

/**
 * Shutdown must flush what background work was in the middle of writing.
 *
 * Periodic work ran as `void fn().catch(...)` — held by nothing. Shutdown could
 * not see it, so the store closed underneath a discovery pass that was halfway
 * through recording its pacing state, and the backoff row that keeps the next
 * boot from hammering a provider which had just rate-limited us was simply
 * lost. That is the one moment the row matters.
 */
describe('Shutdown flushes background work', () => {
  let dataDir: string;
  let dbPath: string;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-flush-'));
    dbPath = join(dataDir, 'flush.db');
  });
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  it('waits for a background pass instead of closing the store underneath it', async () => {
    const app = await App.create(
      loadConfig({
        MERIDIAN_DATA_DIR: dataDir,
        MERIDIAN_DB: dbPath,
        MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
        MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
        MERIDIAN_MASTER_KEY: 'shutdown-flush-test-master-key',
        MERIDIAN_LOG_LEVEL: 'error',
        MERIDIAN_HEALTH_INTERVAL_MS: '0',
        MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
        PORT: '0',
      } as NodeJS.ProcessEnv),
    );
    await app.start();

    // Background work that writes to the store after a delay — the shape of a
    // discovery pass finishing just as the process is asked to stop.
    let wrote = false;
    const inner = app as unknown as { background: (l: string, f: () => Promise<void>) => Promise<void> };
    void inner.background('slow pacing write', async () => {
      await new Promise<void>((r) => setTimeout(r, 150));
      app.store.saveDiscoverySchedule('flush-test', {
        providerId: 'acme',
        lastAttemptAt: 1,
        lastSuccessAt: null,
        consecutiveFailures: 4,
        nextEligibleAt: 9_999_999_999,
        lastError: 'rate limited',
      });
      wrote = true;
    });

    await app.stop();
    assert.equal(wrote, true, 'shutdown must wait for the write rather than racing it');

    // And it is really on disk, readable by the next process.
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .prepare('SELECT consecutive_failures FROM discovery_schedule WHERE scope = ? AND provider_id = ?')
        .get('flush-test', 'acme') as { consecutive_failures: number } | undefined;
      assert.equal(row?.consecutive_failures, 4, 'the pacing row must survive the shutdown that raced it');
    } finally {
      raw.close();
    }
  });

  it('the flushed row is what stops the next boot hammering a failing provider', () => {
    // The consequence, stated as behaviour rather than as a row: a scheduler
    // built over that database refuses to query the provider again.
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: dbPath,
      MERIDIAN_MASTER_KEY: 'shutdown-flush-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);
    const db = openDatabase(config.databasePath, nullLogger);
    const store = new Store(db, SecretBox.create(db, config.masterKey));
    const scheduler = new DiscoveryScheduler({
      maxConsecutiveFailures: 3,
      now: () => 1_000,
      persistence: schedulePersistence(store, 'flush-test'),
    });
    const verdict = scheduler.canRun('acme');
    assert.equal(verdict.allowed, false, 'four recorded failures must still pause it after the restart');
    assert.match(verdict.reason ?? '', /consecutive failures/);
    db.close();
  });
});
