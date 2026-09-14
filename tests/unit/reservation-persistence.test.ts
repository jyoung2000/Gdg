import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, nullLogger, type InferencePool, type Reservation } from '@meridian/shared';
import { PoolManager } from '@meridian/routing-sdk';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';

/**
 * A reservation's budget has to mean something after a restart.
 *
 * A reservation is a window an operator deliberately opens — "this pool, this
 * afternoon, up to twenty dollars" — and its budget is the only thing bounding
 * it. That budget was enforced against a counter held in memory and written to
 * the database exactly once, when the reservation was created. So a gateway
 * that restarted inside the window reloaded the reservation at zero spent, and
 * the twenty dollars became twenty more. Once per restart, silently, with the
 * reservation reporting a clean slate every time.
 */
describe('Reservation spend survives a restart', () => {
  const POOL: InferencePool = {
    id: 'pool_res',
    name: 'Reserved',
    description: 'A pool with a reserved window over it.',
    fallbackPoolId: null,
    builtin: false,
    strategy: 'CHEAP',
    members: [],
    maxConcurrency: 4,
    dailyBudget: null,
    enabled: true,
    createdAt: 1,
  };

  const NOW = 1_700_000_000_000;
  const reservation = (): Reservation => ({
    id: 'res_1',
    poolId: POOL.id,
    label: 'Launch afternoon',
    startAt: NOW - 60_000,
    endAt: NOW + 3_600_000,
    maxConcurrency: 4,
    budget: 1,
    fallbackPoolId: null,
    models: [],
    status: 'active',
    used: 0,
    spend: 0,
    createdAt: NOW - 60_000,
  });

  const withStore = <T>(fn: (store: Store) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-reservation-'));
    try {
      const config = loadConfig({
        MERIDIAN_DATA_DIR: dir,
        MERIDIAN_DB: join(dir, 'res.db'),
        MERIDIAN_MASTER_KEY: 'reservation-persistence-test-master-key',
        MERIDIAN_LOG_LEVEL: 'error',
      } as NodeJS.ProcessEnv);
      const db = openDatabase(config.databasePath, nullLogger);
      return fn(new Store(db, SecretBox.create(db, config.masterKey)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** A pool manager wired exactly as the gateway wires one. */
  const build = (store: Store): PoolManager => {
    const pools = new PoolManager(() => NOW);
    pools.load(store.listPools(), store.listReservations());
    pools.onReservationChange((r) => store.saveReservation(r));
    return pools;
  };

  it('keeps what a reservation has spent across a restart', () => {
    withStore((store) => {
      store.savePool(POOL);
      const first = build(store);
      first.addReservation(reservation());
      first.recordSpend(POOL.id, 0.4);
      first.recordSpend(POOL.id, 0.35);

      const second = build(store);
      const reloaded = second.listReservations().find((r) => r.id === 'res_1');
      assert.ok(reloaded, 'the reservation itself must reload');
      assert.equal(reloaded.used, 2, 'two calls were made against it');
      assert.ok(Math.abs(reloaded.spend - 0.75) < 1e-9, `expected $0.75 spent, got $${reloaded.spend}`);
    });
  });

  it('still enforces the budget after a restart', () => {
    withStore((store) => {
      store.savePool(POOL);
      const first = build(store);
      first.addReservation(reservation());
      // $0.90 of a $1.00 window.
      first.recordSpend(POOL.id, 0.9);
      assert.ok(
        first.capacityBlock(POOL.id, 0.5) !== null,
        'a 50c call must not fit in the 10c left — otherwise this proves nothing after the restart either',
      );

      const second = build(store);
      const block = second.capacityBlock(POOL.id, 0.5);
      assert.ok(block !== null, 'restarting must not hand the reservation its budget back');
      assert.match(block ?? '', /budget of \$1\.00/, `got: ${block}`);
      // And the headroom that genuinely remains is still usable: this is a
      // budget, not a shutdown.
      assert.equal(second.capacityBlock(POOL.id, 0.05), null, '5c still fits in the 10c left');
    });
  });

  it('keeps a cancelled reservation cancelled', () => {
    withStore((store) => {
      store.savePool(POOL);
      const first = build(store);
      first.addReservation(reservation());
      first.cancelReservation('res_1');

      const second = build(store);
      assert.equal(
        second.listReservations().find((r) => r.id === 'res_1')?.status,
        'cancelled',
        'a cancellation that a restart undoes would silently re-open a window an operator closed',
      );
    });
  });
});
