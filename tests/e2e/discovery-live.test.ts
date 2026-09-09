import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscoveryRegistry,
  FreeLlmHubSource,
  MnfstSource,
  UzairSource,
  datasetSources,
  nativeSources,
  type DiscoveryContext,
} from '@meridian/model-sdk';
import { isZeroCost } from '@meridian/shared';

/**
 * The discovery sources against the real upstreams.
 *
 * Three of the six are reachable from here — the datasets, all served from
 * `raw.githubusercontent.com`. The three provider-native sources are not: this
 * environment's egress policy refuses openrouter.ai, huggingface.co and
 * pollinations.ai at CONNECT, so what runs against them is the *failure* path,
 * which is worth running: a source that cannot be reached must report that and
 * leave every other source working.
 *
 * A test that quietly passes when the network is absent is worse than no test,
 * so an unreachable upstream skips with a reason rather than passing, and the
 * skip names the host.
 */

const TIMEOUT_MS = 25_000;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

let online = false;
let cacheDir = '';

before(async () => {
  online = await reachable('https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json');
  cacheDir = mkdtempSync(join(tmpdir(), 'meridian-discovery-live-'));
});

function context(): DiscoveryContext {
  return { cacheDir, now: Date.now(), timeoutMs: TIMEOUT_MS, existingIds: new Set(['groq', 'openrouter', 'huggingface']) };
}

describe('Discovery sources, against the real upstreams', () => {
  it('free-llm-api-hub serves a catalogue, and it is the catalogue', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const snap = await new FreeLlmHubSource().load(context());
    assert.equal(snap.error, null, snap.error ?? '');
    assert.ok(snap.providers.length >= 40, `only ${snap.providers.length} providers came back`);
    assert.ok(snap.version, 'the dataset published no version');
    // Some entries have to be callable or the import is decoration.
    assert.ok(snap.providers.some((p) => p.descriptor), 'nothing in the dataset produced a route');
  });

  it('uzair004 serves structured free-tier limits, and they reach Pricing.freeQuota', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const snap = await new UzairSource().load(context());
    assert.equal(snap.error, null, snap.error ?? '');
    assert.ok(snap.models.length > 0, 'no models');
    // This field was defined and never populated by anything. It is what a
    // quota-aware free-first policy has to read, so an empty one is a policy
    // that cannot bind.
    const withQuota = snap.models.filter((m) => m.pricing?.freeQuota);
    assert.ok(withQuota.length > 0, 'nothing populated freeQuota');
    const quota = withQuota[0].pricing?.freeQuota;
    assert.ok(
      typeof quota?.requestsPerMinute === 'number' || typeof quota?.tokensPerDay === 'number',
      `freeQuota came back with no numbers in it: ${JSON.stringify(quota)}`,
    );
  });

  it('mnfst serves model listings, and none of them are called free on the strength of the repository’s name', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const snap = await new MnfstSource().load(context());
    assert.equal(snap.error, null, snap.error ?? '');
    assert.ok(snap.models.length > 0, 'no models');
    // The repository is called "awesome-free-llm-apis". It publishes no
    // per-entry statement of what kind of free anything is, so every entry has
    // to come out UNKNOWN — and UNKNOWN must not satisfy a zero-cost check.
    for (const provider of snap.providers) {
      assert.equal(provider.intelligence?.freeAccess, 'UNKNOWN', `${provider.providerId} was classified from the list's title`);
      assert.equal(isZeroCost(provider.intelligence?.freeAccess ?? 'UNKNOWN'), false);
    }
  });

  it('caches what it fetched, and a second pass costs upstream nothing', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const first = await new FreeLlmHubSource().load(context());
    const second = await new FreeLlmHubSource().load(context());
    assert.equal(first.providers.length, second.providers.length);
    // The validators were sent and upstream answered 304, so the second pass
    // transferred no body. These are free, community-run repositories; polling
    // them impolitely is how a free thing stops being free.
    assert.equal(second.fromCache, true, 'the second pass re-downloaded the whole dataset');
  });

  it('an unreachable source reports itself and leaves the others working', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    // The provider-native endpoints are blocked here, so this is the real
    // failure path rather than a simulated one.
    const result = await new DiscoveryRegistry().registerAll([...datasetSources(), ...nativeSources()]).load(context());

    const ok = result.sources.filter((s) => s.ok);
    const failed = result.sources.filter((s) => !s.ok);
    assert.ok(ok.length >= 3, `expected the datasets to load; got ${ok.map((s) => s.id).join(', ')}`);
    assert.ok(result.models.length > 100, `only ${result.models.length} models survived a partial outage`);
    for (const source of failed) {
      assert.ok(source.error, `${source.id} failed without saying why`);
      assert.equal(source.models, 0);
    }
  });

  it('merges the datasets under precedence, and shows what beat what', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const result = await new DiscoveryRegistry().registerAll(datasetSources()).load(context());

    const contested = result.models.filter((m) => m.contributors.length > 1);
    assert.ok(contested.length > 0, 'no model was claimed by more than one source, so nothing was merged');

    for (const model of contested) {
      for (const origin of model.origins) {
        for (const loser of origin.overruled) {
          assert.ok(
            origin.standing > loser.standing,
            `${model.modelId}.${origin.field}: ${origin.sourceId} won with no more standing than ${loser.sourceId}`,
          );
        }
      }
    }

    // Every claim that survived names the source it came from, or the UI cannot
    // say "this came from a community list in August" and will imply Meridian
    // checked it.
    for (const model of result.models) {
      assert.ok(model.provenance.source, `${model.modelId} has no provenance`);
      assert.ok(result.sources.some((s) => s.id === model.provenance.source), `${model.modelId} cites a source that did not load`);
    }
  });

  it('records the licence and attribution of everything it redistributes', async (t) => {
    if (!online) return t.skip('raw.githubusercontent.com is unreachable from here');
    const result = await new DiscoveryRegistry().registerAll(datasetSources()).load(context());
    for (const source of result.sources) {
      assert.ok(source.license, `${source.id} has no licence recorded`);
      assert.ok(source.attribution, `${source.id} has no attribution recorded`);
    }
  });
});

describe('Cleanup', () => {
  it('removes the cache it created', () => {
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });
});
