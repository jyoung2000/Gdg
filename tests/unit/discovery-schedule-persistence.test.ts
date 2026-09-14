import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, nullLogger } from '@meridian/shared';
import { DiscoveryScheduler } from '@meridian/control-sdk';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';
import { schedulePersistence } from '../../apps/gateway/src/services/schedule-store.js';

/**
 * Politeness that survives a restart.
 *
 * The scheduler's whole job is to be careful with other people's APIs: a
 * minimum interval, exponential backoff, and a hard pause once a provider has
 * failed enough times in a row that something is genuinely wrong. All of it
 * lived in a Map, which is exactly backwards — a restart is *most* likely when
 * things are going badly, and the old behaviour was to come back up having
 * forgotten every reason to be careful and query the failing provider again
 * immediately. A crash loop turned into a request loop.
 *
 * These tests restart the scheduler for real: a second instance, built over the
 * same database, with nothing carried across in memory.
 */
describe('Discovery pacing survives a restart', () => {
  const withStore = <T>(fn: (store: Store) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-schedule-'));
    try {
      const config = loadConfig({
        MERIDIAN_DATA_DIR: dir,
        MERIDIAN_DB: join(dir, 'schedule.db'),
        MERIDIAN_MASTER_KEY: 'discovery-schedule-test-master-key',
        MERIDIAN_LOG_LEVEL: 'error',
      } as NodeJS.ProcessEnv);
      const db = openDatabase(config.databasePath, nullLogger);
      return fn(new Store(db, SecretBox.create(db, config.masterKey)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const build = (store: Store, now: () => number): DiscoveryScheduler =>
    new DiscoveryScheduler({
      minIntervalMs: 60_000,
      baseBackoffMs: 30_000,
      maxBackoffMs: 3_600_000,
      maxConsecutiveFailures: 3,
      now,
      // Fixed, so the backoff is a number the test can state rather than guess.
      random: () => 0.5,
      persistence: schedulePersistence(store, 'test-scope'),
    });

  it('keeps the failure pause across a restart', () => {
    withStore((store) => {
      let clock = 1_700_000_000_000;
      const first = build(store, () => clock);
      for (let i = 0; i < 3; i++) first.markFailure('acme', 'upstream said no');
      assert.equal(first.canRun('acme').allowed, false, 'three failures must pause it in the first process');

      // A week later, in a brand new process. Long enough that every backoff
      // has elapsed: only the pause itself can still be holding it.
      clock += 7 * 86_400_000;
      const second = build(store, () => clock);
      const verdict = second.canRun('acme');
      assert.equal(verdict.allowed, false, 'a restart must not clear a provider that failed three times running');
      assert.match(verdict.reason ?? '', /consecutive failures/, `got: ${verdict.reason}`);
      assert.equal(second.scheduleOf('acme').consecutiveFailures, 3, 'the failure count itself is what was lost before');
      assert.equal(second.scheduleOf('acme').lastError, 'upstream said no', 'and with it the reason to show an operator');
    });
  });

  it('keeps a backoff window across a restart', () => {
    withStore((store) => {
      let clock = 1_700_000_000_000;
      const first = build(store, () => clock);
      first.markFailure('acme', 'rate limited');
      const until = first.scheduleOf('acme').nextEligibleAt;
      assert.ok(until > clock, 'the first failure must push the next attempt out');

      // Restart one second later: well inside the backoff.
      clock += 1_000;
      const second = build(store, () => clock);
      const verdict = second.canRun('acme');
      assert.equal(verdict.allowed, false, 'the backoff must still bind after a restart');
      assert.equal(second.scheduleOf('acme').nextEligibleAt, until, 'and to the same absolute moment, not a fresh window');

      // Past every window, the restarted scheduler lets the provider through —
      // a persisted backoff that never expired would be its own bug. Past the
      // minimum interval too, which is longer than this backoff step and would
      // otherwise be the thing doing the blocking.
      clock = until + 60_001;
      assert.equal(build(store, () => clock).canRun('acme').allowed, true);
    });
  });

  it('keeps the minimum interval across a restart', () => {
    withStore((store) => {
      let clock = 1_700_000_000_000;
      build(store, () => clock).markSuccess('acme');

      clock += 10_000;
      const after = build(store, () => clock).canRun('acme');
      assert.equal(after.allowed, false, 'a successful listing ten seconds ago is not worth repeating');
      assert.match(after.reason ?? '', /queried recently/);
    });
  });

  it('forgets a provider an operator has cleared, permanently', () => {
    withStore((store) => {
      let clock = 1_700_000_000_000;
      const first = build(store, () => clock);
      for (let i = 0; i < 3; i++) first.markFailure('acme', 'bad credential');
      first.reset('acme');
      assert.equal(first.canRun('acme').allowed, true, 'clearing the pause must work in this process');

      clock += 1_000;
      assert.equal(
        build(store, () => clock).canRun('acme').allowed,
        true,
        'and the next process must not resurrect it — the operator fixed the cause',
      );
    });
  });

  it('does not let one scheduler read the other one’s pacing', () => {
    withStore((store) => {
      const clock = () => 1_700_000_000_000;
      const discovery = new DiscoveryScheduler({ now: clock, persistence: schedulePersistence(store, 'provider-discovery') });
      const datasets = new DiscoveryScheduler({ now: clock, persistence: schedulePersistence(store, 'free-inference') });
      discovery.markFailure('acme', 'down');

      assert.equal(datasets.scheduleOf('acme').consecutiveFailures, 0, 'two schedulers, two rates, two rows');
      assert.equal(
        new DiscoveryScheduler({ now: clock, persistence: schedulePersistence(store, 'free-inference') }).canRun('acme').allowed,
        true,
      );
    });
  });
});
