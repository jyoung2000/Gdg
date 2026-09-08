import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger, timeoutSignal } from '@meridian/shared';
import { createRegistry, discoverEnvCredentials, type AdapterContext } from '@meridian/provider-sdk';

/**
 * Live provider verification.
 *
 * Nothing here runs unless the operator has supplied a credential, and nothing
 * that can charge money runs unless they have also said so explicitly and named
 * a ceiling. Run through `pnpm test:live`, which enforces both before this file
 * is even loaded.
 *
 * The output is a support matrix built from what each provider actually did:
 * whether it listed models, answered a completion, and streamed one. A provider
 * that is not credentialed here is reported as unverified — never as working.
 */

const MAX_COST_USD = Number(process.env.LIVE_TEST_MAX_COST_USD ?? '0');
const ALLOW_PAID = process.env.ALLOW_PAID_LIVE_TESTS === 'true';

interface Row {
  providerId: string;
  listed: number | null;
  chat: 'ok' | 'failed' | 'unsupported' | null;
  streamed: 'ok' | 'failed' | 'unsupported' | null;
  costUsd: number;
  detail: string;
}

describe('Live providers', async () => {
  const registry = createRegistry();
  const credentials = discoverEnvCredentials(registry.list());
  const rows: Row[] = [];
  let outDir: string;
  let spent = 0;

  before(() => {
    outDir = mkdtempSync(join(tmpdir(), 'meridian-live-'));
  });

  after(() => {
    const path = join(process.cwd(), 'docs/evidence/PROVIDER_LIVE.md');
    const lines = [
      '# Live provider verification',
      '',
      `Run ${new Date().toISOString()} by \`pnpm test:live\`.`,
      '',
      `Paid requests: ${ALLOW_PAID ? `permitted, ceiling $${MAX_COST_USD}` : 'not permitted'}.`,
      `Estimated spend this run: $${spent.toFixed(6)}.`,
      '',
      '| Provider | Models listed | Chat | Streaming | Cost | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.providerId} | ${r.listed ?? '—'} | ${r.chat ?? '—'} | ${r.streamed ?? '—'} | $${r.costUsd.toFixed(6)} | ${r.detail} |`,
      ),
      '',
      'Providers absent from this table have no credential in this environment and',
      'are therefore unverified. Unverified is not a synonym for broken, and it is',
      'certainly not a synonym for working.',
      '',
    ];
    try {
      writeFileSync(path, lines.join('\n'));
      process.stdout.write(`\nWrote ${path}\n`);
    } catch {
      process.stdout.write(`\n${lines.join('\n')}\n`);
    }
    rmSync(outDir, { recursive: true, force: true });
  });

  it('has at least one credentialed provider, or there is nothing to verify', () => {
    assert.ok(
      credentials.length > 0,
      'No provider credential is present in the environment. Set one (see docs/CONFIGURATION.md) before running the live suite.',
    );
  });

  for (const credential of credentials) {
    const descriptor = registry.descriptor(credential.providerId);
    if (!descriptor) continue;

    it(`verifies ${credential.providerId}`, async () => {
      const adapter = registry.get(descriptor.id);
      assert.ok(adapter, `${descriptor.id} has no adapter`);
      const caps = adapter.surface();
      const row: Row = { providerId: descriptor.id, listed: null, chat: null, streamed: null, costUsd: 0, detail: '' };

      const ctx: AdapterContext = {
        secret: credential.secret,
        logger: nullLogger,
        requestId: `live-${descriptor.id}`,
        timeoutMs: 60_000,
        signal: timeoutSignal(60_000),
      };

      if (adapter.listModels) {
        try {
          const models = await adapter.listModels(ctx);
          row.listed = models.length;
        } catch (e) {
          row.detail = `listing failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Free capacity is exercised unconditionally; anything that can charge
      // needs explicit permission and a ceiling that has not been reached.
      const free = descriptor.defaultPricing.kind === 'FREE' || descriptor.defaultPricing.kind === 'LOCAL';
      if (!free && !ALLOW_PAID) {
        row.chat = null;
        row.detail = `${row.detail ? `${row.detail}; ` : ''}chat not attempted — ALLOW_PAID_LIVE_TESTS is not set`;
        rows.push(row);
        return;
      }
      if (!free && spent >= MAX_COST_USD) {
        row.detail = `${row.detail ? `${row.detail}; ` : ''}chat not attempted — the $${MAX_COST_USD} ceiling is spent`;
        rows.push(row);
        return;
      }

      const model = row.listed && adapter.listModels ? (await adapter.listModels(ctx))[0]?.providerModelId : undefined;
      if (!model) {
        row.detail = `${row.detail ? `${row.detail}; ` : ''}no model to try`;
        rows.push(row);
        return;
      }

      if (!caps.chat || !adapter.chat) row.chat = 'unsupported';
      else {
        try {
          const res = await adapter.chat(
            { model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16, temperature: 0 },
            ctx,
          );
          row.chat = res.content.trim().length > 0 ? 'ok' : 'failed';
          row.costUsd += res.usage.cost;
          spent += res.usage.cost;
        } catch (e) {
          row.chat = 'failed';
          row.detail = `${row.detail ? `${row.detail}; ` : ''}${e instanceof Error ? e.message : String(e)}`;
        }
      }

      if (!caps.streaming || !adapter.chatStream) row.streamed = 'unsupported';
      else if (!free && spent >= MAX_COST_USD) row.streamed = null;
      else {
        try {
          let text = '';
          for await (const chunk of adapter.chatStream(
            { model, messages: [{ role: 'user', content: 'Count: one two three' }], maxTokens: 32, temperature: 0, stream: true },
            ctx,
          )) {
            if (chunk.type === 'text') text += chunk.delta;
            if (chunk.type === 'usage') {
              row.costUsd += chunk.usage.cost;
              spent += chunk.usage.cost;
            }
          }
          row.streamed = text.trim().length > 0 ? 'ok' : 'failed';
        } catch (e) {
          row.streamed = 'failed';
          row.detail = `${row.detail ? `${row.detail}; ` : ''}${e instanceof Error ? e.message : String(e)}`;
        }
      }

      rows.push(row);
      assert.ok(
        spent <= Math.max(MAX_COST_USD, 0),
        `the live suite spent $${spent.toFixed(6)}, past the $${MAX_COST_USD} ceiling`,
      );
    });
  }
});
