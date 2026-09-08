import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, nullLogger, type RoutingReason, type UsageRecord } from '@meridian/shared';
import { routingSnapshot } from '@meridian/routing-sdk';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';

/**
 * A request has to be answerable after it has finished.
 *
 * Meridian hands every caller an `x-request-id` and, until this pass, kept
 * nothing that could be looked up by one: no index selected on it, no query
 * accepted it, and the routing decision that spent the money was computed in
 * full and then dropped. "Why did this request pick that model" had no answer
 * for anything already over.
 */

function openStore(dir: string, name: string): Store {
  const config = loadConfig({
    MERIDIAN_DATA_DIR: dir,
    MERIDIAN_DB: join(dir, name),
    MERIDIAN_MASTER_KEY: 'trace-test-key',
    MERIDIAN_LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);
  const db = openDatabase(config.databasePath, nullLogger);
  return new Store(db, SecretBox.create(db, config.masterKey));
}

function usageRow(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `use_${Math.random().toString(36).slice(2, 10)}`,
    at: 1_000,
    requestId: 'req_a',
    userId: null,
    workspaceId: null,
    taskId: null,
    agentRole: null,
    stepId: null,
    providerId: 'sim',
    modelId: 'sim:chat',
    credentialId: null,
    poolId: null,
    modality: 'text',
    taskType: 'chat',
    promptTokens: 100,
    completionTokens: 20,
    cost: 0,
    latencyMs: 40,
    ttftMs: 10,
    success: true,
    fallbackCount: 0,
    errorCode: null,
    ...over,
  };
}

describe('Request trace — a verdict lands on the step that earned it', () => {
  it('separates two runs of the same role within one task', () => {
    // The exact shape escalation produces: a tester fails, a repair attempt is
    // appended, and the tester runs again. Both steps carry the role `tester`,
    // and only the second one passed.
    const dir = mkdtempSync(join(tmpdir(), 'meridian-trace-'));
    try {
      const store = openStore(dir, 'attribution.db');
      store.recordUsage(usageRow({ requestId: 'req_1', taskId: 'task_1', agentRole: 'tester', stepId: 'step_first', modelId: 'sim:weak', at: 1000 }));
      store.recordUsage(usageRow({ requestId: 'req_2', taskId: 'task_1', agentRole: 'debugger', stepId: 'step_repair', modelId: 'sim:fixer', at: 2000 }));
      store.recordUsage(usageRow({ requestId: 'req_3', taskId: 'task_1', agentRole: 'tester', stepId: 'step_second', modelId: 'sim:strong', at: 3000 }));

      // What the old code did. Kept as an assertion rather than a comment
      // because it is the defect: the pass earned by `step_second` was applied
      // to `step_first` as well, crediting the model that failed.
      const byRole = store.listUsage({ taskId: 'task_1' }).filter((r) => r.agentRole === 'tester');
      assert.equal(byRole.length, 2, 'role alone cannot tell two runs of a role apart');

      const byStep = store.listUsage({ taskId: 'task_1', stepId: 'step_second' });
      assert.equal(byStep.length, 1, 'a verdict belongs to one step');
      assert.equal(byStep[0].modelId, 'sim:strong', 'and to the model that actually ran it');
      assert.equal(byStep[0].stepId, 'step_second', 'the step id has to survive the round trip, or the filter is filtering on nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds every attempt a request made, in the order it made them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-trace-lookup-'));
    try {
      const store = openStore(dir, 'lookup.db');
      // One request, three attempts: two failures and the fallback that worked.
      store.recordUsage(usageRow({ requestId: 'req_fallback', modelId: 'sim:a', success: false, errorCode: 'rate_limited', at: 10 }));
      store.recordUsage(usageRow({ requestId: 'req_fallback', modelId: 'sim:a', success: false, errorCode: 'rate_limited', at: 20, fallbackCount: 0 }));
      store.recordUsage(usageRow({ requestId: 'req_fallback', modelId: 'sim:b', success: true, at: 30, fallbackCount: 1 }));
      store.recordUsage(usageRow({ requestId: 'req_other', modelId: 'sim:c', at: 40 }));

      const trace = store.listUsage({ requestId: 'req_fallback' }).sort((a, b) => a.at - b.at);
      assert.equal(trace.length, 3, 'every attempt is part of the trace, not just the one that succeeded');
      assert.deepEqual(trace.map((r) => r.modelId), ['sim:a', 'sim:a', 'sim:b']);
      assert.equal(trace.at(-1)?.success, true);
      assert.ok(
        !trace.some((r) => r.requestId === 'req_other'),
        'a lookup by request id must not return another request',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the routing decision and the tokens optimisation saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-trace-routing-'));
    try {
      const store = openStore(dir, 'routing.db');
      store.recordUsage(
        usageRow({
          requestId: 'req_why',
          contextTokensSaved: 4_200,
          routing: {
            mode: 'CHEAP_FIRST',
            requestedMode: 'AUTO',
            summary: 'Cheapest published rate on a healthy provider',
            considered: [{ modelId: 'sim:b', score: 0.81, estimatedCost: 0.0004, costClass: 'KNOWN_PAID' }],
            rejected: [{ reason: 'Price is not published', count: 12 }],
          },
        }),
      );
      // A second Store on the same file: the question is what reached the disk.
      const reopened = openStore(dir, 'routing.db');
      const row = reopened.listUsage({ requestId: 'req_why' })[0];
      assert.ok(row, 'the row must come back at all');
      assert.equal(row.routing?.mode, 'CHEAP_FIRST');
      assert.equal(row.routing?.requestedMode, 'AUTO', 'what the caller asked for is not always what ran');
      assert.equal(row.routing?.considered[0]?.modelId, 'sim:b');
      assert.equal(row.routing?.rejected[0]?.count, 12);
      assert.equal(row.contextTokensSaved, 4_200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a row written before the trace columns existed without inventing values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-trace-legacy-'));
    try {
      const store = openStore(dir, 'legacy.db');
      store.recordUsage(usageRow({ requestId: 'req_old' }));
      const row = store.listUsage({ requestId: 'req_old' })[0];
      // Null, never 0 and never {}. "No optimiser ran" and "it ran and saved
      // nothing" are different facts, and a UI that renders them the same way
      // reports a saving that never happened.
      assert.equal(row.contextTokensSaved, null);
      assert.equal(row.routing, null);
      assert.equal(row.stepId, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Routing snapshot — what is worth keeping from a decision', () => {
  const reason = (over: Partial<RoutingReason> = {}): RoutingReason => ({
    summary: 'Best free model that can call tools',
    criteria: [],
    considered: Array.from({ length: 12 }, (_, i) => ({
      modelId: `sim:m${i}`,
      providerId: 'sim',
      score: 1 - i / 100,
      factors: {},
      estimatedCost: i === 0 ? null : i / 1000,
      costClass: (i === 0 ? 'UNKNOWN_COST' : 'KNOWN_PAID') as 'UNKNOWN_COST' | 'KNOWN_PAID',
      estimatedLatencyMs: 100,
      free: false,
    })),
    rejected: [
      ...Array.from({ length: 40 }, (_, i) => ({ modelId: `x${i}`, reason: 'No credential this caller may use' })),
      ...Array.from({ length: 3 }, (_, i) => ({ modelId: `y${i}`, reason: 'Cannot call tools' })),
    ],
    mode: 'FREE_FIRST',
    requestedMode: 'AUTO',
    ...over,
  });

  it('caps the runners-up instead of storing every candidate on every attempt', () => {
    const snapshot = routingSnapshot(reason());
    assert.equal(snapshot.considered.length, 5);
    assert.equal(snapshot.considered[0].modelId, 'sim:m0', 'the winner is the one that must survive the cap');
  });

  it('collapses rejections to a reason and a count, commonest first', () => {
    const snapshot = routingSnapshot(reason());
    // 43 individual rejection lines say less than two counted reasons, and cost
    // more to store on every single attempt.
    assert.deepEqual(snapshot.rejected, [
      { reason: 'No credential this caller may use', count: 40 },
      { reason: 'Cannot call tools', count: 3 },
    ]);
  });

  it('carries an unknown price through as unknown', () => {
    const snapshot = routingSnapshot(reason());
    assert.equal(snapshot.considered[0].estimatedCost, null, 'an unpublished price must not become a number in the record');
    assert.equal(snapshot.considered[0].costClass, 'UNKNOWN_COST');
  });

  it('records both the policy that ran and the one that was asked for', () => {
    const snapshot = routingSnapshot(reason());
    assert.equal(snapshot.mode, 'FREE_FIRST');
    assert.equal(snapshot.requestedMode, 'AUTO', 'AUTO resolving to something is exactly what a person wants explained');
  });
});
