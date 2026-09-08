import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAIM_STALE_AFTER_DAYS,
  capabilityConfidence,
  claimIsStale,
  loadConfig,
  nullLogger,
  type ModelDescriptor,
} from '@meridian/shared';
import { enrich } from '@meridian/model-sdk';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { SecretBox } from '../../apps/gateway/src/db/crypto.js';
import { Store } from '../../apps/gateway/src/db/store.js';

/** A Store on a real file, exactly as the gateway builds one. */
function openStore(config: ReturnType<typeof loadConfig>): Store {
  const db = openDatabase(config.databasePath, nullLogger);
  return new Store(db, SecretBox.create(db, config.masterKey));
}

/**
 * Evidence about a model has to outlive the process that gathered it.
 *
 * The flat `capabilities` array cannot carry evidence — it says a model has
 * vision, not who said so or how sure they were. `capabilityClaims` carries
 * that, and until now it was computed on every boot and never written down, so
 * the strongest thing anyone could establish about a model lasted exactly as
 * long as the process did.
 */

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'openai:gpt-4o',
    providerId: 'openai',
    providerModelId: 'gpt-4o',
    displayName: 'gpt-4o',
    family: null,
    modalities: ['text'],
    capabilities: ['text'],
    contextLength: null,
    maxOutputTokens: null,
    pricing: { kind: 'METERED', inputPerMTok: 2.5, outputPerMTok: 10, perRequest: null, note: null },
    discovered: true,
    deprecated: false,
    tags: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe('Capability evidence — a heuristic cannot overrule a stronger claim', () => {
  it('keeps a capability an operator marked unsupported out of the capability list', () => {
    // `gpt-4o` matches the vision name heuristic, so re-enrichment is exactly
    // where an operator's finding used to be lost.
    const confirmed = model({
      capabilities: ['text'],
      capabilityClaims: {
        vision: { state: 'user_confirmed', source: 'operator tested it', confidence: 0.95, at: 1000 },
      },
    });
    // Sanity: the heuristic really does want to add vision here.
    assert.ok(
      enrich(model()).capabilities.includes('vision'),
      'this fixture must match the vision heuristic, or the test proves nothing',
    );

    const enriched = enrich({
      ...confirmed,
      capabilityClaims: {
        vision: { state: 'user_confirmed', source: 'operator tested it: it cannot see', confidence: 0.95, at: 1000 },
      },
    });
    // The operator's claim is `user_confirmed` and positive here, so vision is
    // allowed. The interesting case is the negative one below.
    assert.ok(enriched.capabilities.includes('vision'));
  });

  it('drops a capability whose strongest claim says unsupported, however the name reads', () => {
    const tested = model({
      capabilities: ['text'],
      capabilityClaims: {
        vision: { state: 'unsupported', source: 'operator sent an image and it was rejected', confidence: 0.95, at: 1000 },
      },
    });

    const enriched = enrich(tested, { now: 2000 });

    assert.ok(
      !enriched.capabilities.includes('vision'),
      'a name guess must not reinstate a capability that was tested and found absent',
    );
    assert.equal(enriched.capabilityClaims?.vision?.state, 'unsupported', 'and the finding itself must survive');
  });

  it('still lets the heuristic add a capability nobody has ruled out', () => {
    const enriched = enrich(model(), { now: 2000 });
    assert.ok(enriched.capabilities.includes('vision'));
    assert.equal(enriched.capabilityClaims?.vision?.state, 'inferred');
  });
});

describe('Capability evidence — survives a restart', () => {
  it('round-trips claims, first-seen and last-verified through the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-claims-'));
    try {
      const config = loadConfig({
        MERIDIAN_DATA_DIR: dir,
        MERIDIAN_DB: join(dir, 'claims.db'),
        MERIDIAN_MASTER_KEY: 'claims-test-key',
        MERIDIAN_LOG_LEVEL: 'error',
      } as NodeJS.ProcessEnv);

      const write = openStore(config);
      write.upsertModels([
        model({
          capabilities: ['text'],
          capabilityClaims: {
            vision: { state: 'unsupported', source: 'operator sent an image and it was rejected', confidence: 0.95, at: 1000 },
            tools: { state: 'probe_verified', source: 'live probe', confidence: 1, at: 1200 },
          },
          discoveredAt: 500,
          lastVerifiedAt: 1200,
        }),
      ]);

      // A second Store on the same file is the restart: nothing is shared but
      // what reached the disk.
      const read = openStore(config);
      const loaded = read.listModels().find((m) => m.id === 'openai:gpt-4o');
      assert.ok(loaded, 'the model must come back at all');
      assert.equal(loaded.capabilityClaims?.vision?.state, 'unsupported');
      assert.equal(loaded.capabilityClaims?.tools?.state, 'probe_verified');
      assert.equal(loaded.capabilityClaims?.tools?.source, 'live probe');
      assert.equal(loaded.discoveredAt, 500);
      assert.equal(loaded.lastVerifiedAt, 1200);

      // And the whole point: re-enriching what came back must not undo it.
      const reEnriched = enrich(loaded, { now: 9000 });
      assert.ok(
        !reEnriched.capabilities.includes('vision'),
        'a restart followed by rediscovery must not reinstate a capability that was ruled out',
      );
      assert.equal(reEnriched.discoveredAt, 500, 'first sighting is a fact about the past and must not move');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the earliest first-seen when a later pass reports a newer one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-claims-age-'));
    try {
      const config = loadConfig({
        MERIDIAN_DATA_DIR: dir,
        MERIDIAN_DB: join(dir, 'age.db'),
        MERIDIAN_MASTER_KEY: 'age-test-key',
        MERIDIAN_LOG_LEVEL: 'error',
      } as NodeJS.ProcessEnv);

      const store = openStore(config);
      store.upsertModels([model({ discoveredAt: 500, lastVerifiedAt: 500 })]);
      store.upsertModels([model({ discoveredAt: 9000, lastVerifiedAt: 9000 })]);

      const loaded = store.listModels().find((m) => m.id === 'openai:gpt-4o');
      assert.equal(loaded?.discoveredAt, 500, 'a rediscovery must not reset how long we have known about a model');
      assert.equal(loaded?.lastVerifiedAt, 9000, 'but the most recent confirmation is the one that counts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Capability evidence — a verification does not stay fresh forever', () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;

  it('treats a recent claim as current', () => {
    const fresh = { state: 'probe_verified' as const, source: 'live probe', confidence: 1, at: now - 10 * DAY };
    assert.equal(claimIsStale(fresh, now), false);
    assert.equal(capabilityConfidence({ tools: fresh }, ['tools'], ['tools'], now), 1);
  });

  it('discounts a claim older than the staleness window', () => {
    const old = { state: 'probe_verified' as const, source: 'live probe', confidence: 1, at: now - (CLAIM_STALE_AFTER_DAYS + 30) * DAY };
    assert.equal(claimIsStale(old, now), true);
    const confidence = capabilityConfidence({ tools: old }, ['tools'], ['tools'], now);
    assert.ok(confidence < 1, 'a verification from months ago is weaker than one from this morning');
    assert.ok(confidence > 0.7, 'but it is still worth more than a guess, or running one would be pointless');
  });

  it('never decays established evidence below a bare guess', () => {
    const ancient = { state: 'provider_declared' as const, source: 'listing', confidence: 0.9, at: 0 };
    const guessed = { state: 'inferred' as const, source: 'model-name heuristic', confidence: 0.5, at: now };
    assert.ok(
      capabilityConfidence({ tools: ancient }, ['tools'], ['tools'], now) >=
        capabilityConfidence({ tools: guessed }, ['tools'], ['tools'], now),
      'however old, something someone established beats something nobody did',
    );
  });

  it('lets the weakest required capability decide', () => {
    const strong = { state: 'probe_verified' as const, source: 'probe', confidence: 1, at: now };
    const weak = { state: 'inferred' as const, source: 'heuristic', confidence: 0.5, at: now };
    const both = capabilityConfidence({ tools: strong, vision: weak }, ['tools', 'vision'], ['tools', 'vision'], now);
    assert.equal(both, capabilityConfidence({ vision: weak }, ['vision'], ['vision'], now));
  });
});
