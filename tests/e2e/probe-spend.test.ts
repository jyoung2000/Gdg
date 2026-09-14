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

  /**
   * Two deployments, because the interesting property is the difference.
   *
   * `locked` has MERIDIAN_ALLOW_PAID off — the setting an operator sets once
   * and then trusts. `open` has it on, which is the only configuration in
   * which any of the accounting below can happen at all.
   */
  let locked: App;

  const bootApp = async (name: string, allowPaid: boolean): Promise<App> => {
    const created = await App.create(
      loadConfig({
        MERIDIAN_DATA_DIR: join(dataDir, name),
        MERIDIAN_DB: join(dataDir, `${name}.db`),
        MERIDIAN_WORKSPACE_ROOT: join(dataDir, name, 'workspaces'),
        MERIDIAN_ASSET_ROOT: join(dataDir, name, 'assets'),
        MERIDIAN_MASTER_KEY: 'probe-spend-test-master-key',
        MERIDIAN_LOG_LEVEL: 'error',
        MERIDIAN_HEALTH_INTERVAL_MS: '0',
        MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
        MERIDIAN_ALLOW_PAID: allowPaid ? 'true' : 'false',
        PORT: '0',
      } as NodeJS.ProcessEnv),
    );
    await created.start();
    created.providers.registerProvider(mock.descriptor);
    created.providers.setCredentialed('probe-mock', true);
    created.models.upsert(paidModel('paid-a'));
    created.models.upsert(paidModel('paid-b'));
    return created;
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-probe-spend-'));
    // A mock that reports token usage, because the whole point is what the
    // provider says it charged rather than what we guessed.
    mock = await startMockProvider('probe-mock', { usage: { prompt: 1000, completion: 500 }, reply: 'yes' });
    locked = await bootApp('locked', false);
    app = await bootApp('open', true);
  });

  after(async () => {
    await app?.stop();
    await locked?.stop();
    await mock?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const probeRows = (): ReturnType<App['store']['listUsage']> =>
    app.store.listUsage({ limit: 500 }).filter((u) => u.taskType === 'capability-probe');

  it('refuses to probe a model that can charge when paid spend is not permitted', async () => {
    const before = mock.calls.length;
    const report = await locked.verification.verify({ modelIds: ['probe-mock:paid-a'] });

    assert.equal(report.probed, 0, 'a metered model must not be probed without permission to spend');
    assert.equal(mock.calls.length, before, 'no request may reach the provider at all — the refusal is before the call');
    assert.equal(report.cost, 0);
    const reason = report.skipped.find((s) => s.modelId === 'probe-mock:paid-a')?.reason ?? '';
    assert.match(reason, /permission to spend/i, `the skip must say why, got: ${reason}`);
    assert.equal(
      locked.store.listUsage({ limit: 500 }).filter((u) => u.taskType === 'capability-probe').length,
      0,
      'nothing was spent, so nothing may be recorded',
    );
  });

  it('does not let one request switch paid spending back on for the whole deployment', async () => {
    // MERIDIAN_ALLOW_PAID is a kill-switch, not a default. Reading it as
    // `request ?? instance` meant a single API call could spend on a
    // deployment whose operator had switched spending off — the one thing a
    // kill-switch may not permit. The router has always required both; this
    // is the same rule in the one place that had drifted from it.
    const before = mock.calls.length;
    const report = await locked.verification.verify({
      modelIds: ['probe-mock:paid-a'],
      capabilities: ['text'],
      allowPaid: true,
      maxCostUsd: 1000,
    });

    assert.equal(report.probed, 0, 'a request must not be able to overrule the instance switch');
    assert.equal(mock.calls.length, before, 'and nothing may reach the provider');
    assert.match(report.skipped[0]?.reason ?? '', /permission to spend/i);

    // The converse still holds: where the deployment permits it, withholding
    // permission on the request is respected. Narrowing works; widening does not.
    const withheld = await app.verification.verify({
      modelIds: ['probe-mock:paid-a'],
      capabilities: ['text'],
      allowPaid: false,
    });
    assert.equal(withheld.probed, 0, 'a request may still refuse what the deployment allows');
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

  it('refuses a model that can charge but publishes no rate', async () => {
    // The hole this closes: `computeCost` adds a term per *published* rate, so
    // a METERED card with every rate null prices a probe at exactly $0.00 —
    // while `mayCharge` correctly reports that it can charge. The ceiling
    // compared that zero and let the model through, every time, and the ledger
    // recorded $0.00 for spend nobody could bound. Discovery produces exactly
    // this shape: a metered model whose price book has not caught up yet.
    app.models.upsert({
      ...paidModel('unpriced'),
      pricing: { kind: 'METERED', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null },
    });

    const before = mock.calls.length;
    const spentBefore = probeRows().length;
    const report = await app.verification.verify({
      modelIds: ['probe-mock:unpriced'],
      capabilities: ['text'],
      // Permission granted, and a ceiling far above any real probe. Neither is
      // the point: the cost cannot be shown to fit *any* ceiling.
      allowPaid: true,
      maxCostUsd: 1000,
    });

    assert.equal(report.probed, 0, 'a model whose cost cannot be computed must not be probed');
    assert.equal(mock.calls.length, before, 'and no request may reach the provider');
    assert.equal(probeRows().length, spentBefore, 'and nothing may be recorded');
    const reason = report.skipped.find((s) => s.modelId === 'probe-mock:unpriced')?.reason ?? '';
    assert.match(reason, /publishes no rate/i, `the skip must say the rate is missing, got: ${reason}`);
    assert.doesNotMatch(reason, /\$0\.00/, 'and must never present the unknown cost as zero');
  });

  it('says so when a provider reports no tokens, rather than calling the floor a total', async () => {
    // A per-token rate card plus a provider that reports no usage leaves the
    // probe's real cost unknowable after the fact. Recording the resulting zero
    // and presenting it as the total is the same untruth as calling an
    // unpublished rate free — so the run reports `costKnown: false` and the
    // figure is read as a floor.
    const silent = await startMockProvider('silent-provider', { reply: 'yes', omitUsage: true });
    app.providers.registerProvider(silent.descriptor);
    app.providers.setCredentialed('silent-provider', true);
    app.models.upsert({
      ...paidModel('silent'),
      id: 'silent-provider:silent',
      providerId: 'silent-provider',
      providerModelId: 'silent',
    });

    try {
      const quiet = await app.verification.verify({
        modelIds: ['silent-provider:silent'],
        capabilities: ['text'],
        allowPaid: true,
      });
      assert.equal(quiet.probed, 1, `expected the probe to run: ${JSON.stringify(quiet.skipped)}`);
      assert.equal(
        quiet.costKnown,
        false,
        'a per-token model whose provider reported no tokens leaves the cost unknown, and the run must say so',
      );

      // The same run against a provider that does report its tokens is a
      // figure, not a floor — otherwise this flag would be meaningless.
      const priced = await app.verification.verify({
        modelIds: ['probe-mock:paid-b'],
        capabilities: ['text'],
        allowPaid: true,
      });
      assert.equal(priced.probed, 1);
      assert.equal(priced.costKnown, true, 'a provider that reports its tokens gives a figure');
      assert.ok(priced.cost > 0);
    } finally {
      await silent.close();
    }
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
