import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type ModelDescriptor } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { startMockProvider, type MockProvider } from '../helpers/mock-provider.js';

/**
 * What a capability probe costs, and who is allowed to authorise it.
 *
 * A probe is not a diagnostic that happens to touch a provider — it *is* a
 * provider call, billed at the model's rate card against somebody's key. The
 * verification service used to make those calls directly against the adapter:
 * outside the router, outside the pools, outside the budget, and outside the
 * usage ledger entirely. The consequence was not subtle. An operator who had
 * told Meridian "free models only" could press Verify and spend money on a
 * metered model, and the spend appeared in no total, on no screen and in no
 * report — the Activity view showed the same figure afterwards as before.
 *
 * So three things are checked here, on a real gateway against a real HTTP
 * provider: that a model which can charge is refused without permission, that
 * permission is enough to run it and that running it lands in the ledger with a
 * cost, and that permission alone is not enough — the dollar ceiling still
 * stops the run.
 */
describe('Capability probes: permission, ceiling and accounting', () => {
  let app: App;
  let mock: MockProvider;
  let dataDir: string;

  /** $3/$15 per Mtok — an ordinary frontier rate card, so the maths is real. */
  const PAID = { kind: 'METERED' as const, inputPerMTok: 3, outputPerMTok: 15, perRequest: null, note: null };

  const paidModel = (id: string): ModelDescriptor => ({
    id: `probe-mock:${id}`,
    providerId: 'probe-mock',
    providerModelId: id,
    displayName: id,
    family: null,
    modalities: ['text'],
    capabilities: ['text', 'tools'],
    contextLength: 32_768,
    maxOutputTokens: 4096,
    pricing: PAID,
    discovered: false,
    deprecated: false,
    tags: [],
    updatedAt: Date.now(),
  });

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-probe-spend-'));
    // A mock that reports token usage, because the whole point is what the
    // provider says it charged rather than what we guessed.
    mock = await startMockProvider('probe-mock', { usage: { prompt: 1000, completion: 500 }, reply: 'yes' });

    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'probe.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'probe-spend-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      // The deployment has NOT authorised paid spend. This is the setting an
      // operator sets and then trusts.
      MERIDIAN_ALLOW_PAID: 'false',
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();

    app.providers.registerProvider(mock.descriptor);
    app.providers.setCredentialed('probe-mock', true);
    app.models.upsert(paidModel('paid-a'));
    app.models.upsert(paidModel('paid-b'));
  });

  after(async () => {
    await app?.stop();
    await mock?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const probeRows = (): ReturnType<App['store']['listUsage']> =>
    app.store.listUsage({ limit: 500 }).filter((u) => u.taskType === 'capability-probe');

  it('refuses to probe a model that can charge when paid spend is not permitted', async () => {
    const before = mock.calls.length;
    const report = await app.verification.verify({ modelIds: ['probe-mock:paid-a'] });

    assert.equal(report.probed, 0, 'a metered model must not be probed without permission to spend');
    assert.equal(mock.calls.length, before, 'no request may reach the provider at all — the refusal is before the call');
    assert.equal(report.cost, 0);
    const reason = report.skipped.find((s) => s.modelId === 'probe-mock:paid-a')?.reason ?? '';
    assert.match(reason, /permission to spend/i, `the skip must say why, got: ${reason}`);
    assert.equal(probeRows().length, 0, 'nothing was spent, so nothing may be recorded');
  });

  it('records every probe as usage, with the cost the rate card implies', async () => {
    const report = await app.verification.verify({
      modelIds: ['probe-mock:paid-a'],
      capabilities: ['text'],
      // The explicit permission, given per run, by an admin who meant it.
      allowPaid: true,
      userId: 'probe-operator',
    });

    assert.equal(report.probed, 1, `expected one model probed, got ${report.probed}: ${JSON.stringify(report.skipped)}`);
    assert.ok(report.probeCalls >= 1, 'at least one probe request must have been made');

    const rows = probeRows();
    assert.equal(rows.length, report.probeCalls, 'every probe request must produce exactly one usage row');

    const row = rows[0];
    assert.equal(row.modelId, 'probe-mock:paid-a');
    assert.equal(row.providerId, 'probe-mock');
    assert.equal(row.userId, 'probe-operator', 'the spend belongs to whoever authorised it');
    assert.equal(row.promptTokens, 1000, 'tokens come from what the provider reported');
    assert.equal(row.completionTokens, 500);
    // 1000 in at $3/Mtok + 500 out at $15/Mtok = $0.003 + $0.0075.
    assert.ok(Math.abs(row.cost - 0.0105) < 1e-6, `expected $0.0105 for this probe, got $${row.cost}`);
    assert.ok(report.cost > 0, 'the run must report what it spent');
    assert.ok(
      Math.abs(report.cost - rows.reduce((n, r) => n + r.cost, 0)) < 1e-6,
      "the run's total must be the sum of its rows",
    );
  });

  it('stops at the dollar ceiling even with permission to spend', async () => {
    const spentBefore = probeRows().length;
    const report = await app.verification.verify({
      providerId: 'probe-mock',
      capabilities: ['text'],
      allowPaid: true,
      // Far below one probe's worst case, so the very first model is refused.
      maxCostUsd: 0.000001,
    });

    assert.equal(report.probed, 0, 'the ceiling must bind before anything is sent');
    assert.equal(probeRows().length, spentBefore, 'a run stopped by the ceiling spends nothing');
    const reason = report.skipped[0]?.reason ?? '';
    assert.match(reason, /ceiling/i, `the skip must name the ceiling, got: ${reason}`);
    assert.equal(report.maxCostUsd, 0.000001, 'the report states the ceiling it was held to');
  });
});
