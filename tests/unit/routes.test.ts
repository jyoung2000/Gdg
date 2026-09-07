import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blendedPerMTok, freeRadar, groupRoutes, multiRouteGroups, normalizeModelKey, type RouteContext } from '@meridian/model-sdk';
import type { ModelDescriptor, Pricing, ProviderHealth } from '@meridian/shared';

/**
 * Route comparison: the same model reached different ways.
 *
 * The invariants worth defending are the ones about absent data. An unpriced
 * route must never win "cheapest", an unmeasured route must never win
 * "fastest", and trial credit must never appear on a list of free options.
 */

const pricing = (over: Partial<Pricing> = {}): Pricing => ({
  kind: 'METERED',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  ...over,
});

const model = (providerId: string, providerModelId: string, p: Pricing): ModelDescriptor => ({
  id: `${providerId}:${providerModelId}`,
  providerId,
  providerModelId,
  displayName: providerModelId,
  family: null,
  modalities: ['text'],
  capabilities: ['text'],
  contextLength: 8192,
  maxOutputTokens: null,
  pricing: p,
  discovered: true,
  deprecated: false,
  tags: [],
  updatedAt: 0,
});

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  view: () => null,
  health: () => null,
  supportState: () => 'supported',
  configured: () => true,
  freeAccess: () => null,
  local: () => false,
  ...over,
});

describe('model identity', () => {
  it('collapses publisher prefixes and casing', () => {
    assert.equal(normalizeModelKey('meta-llama/Llama-3.3-70B-Instruct'), 'llama-3.3-70b-instruct');
    assert.equal(normalizeModelKey('llama-3.3-70b-instruct'), 'llama-3.3-70b-instruct');
  });

  it('strips packaging suffixes that do not change the weights', () => {
    assert.equal(normalizeModelKey('mistral-7b:free'), 'mistral-7b');
    assert.equal(normalizeModelKey('qwen-72b-fp8'), 'qwen-72b');
  });

  it('keeps genuinely different models apart', () => {
    // -instruct is not packaging: merging it with the base model would route a
    // request somewhere the caller did not choose.
    assert.notEqual(normalizeModelKey('llama-3-8b'), normalizeModelKey('llama-3-8b-instruct'));
    assert.notEqual(normalizeModelKey('llama-3-8b'), normalizeModelKey('llama-3-70b'));
  });
});

describe('blended price', () => {
  it('weights input and output 3:1', () => {
    assert.equal(blendedPerMTok(model('p', 'm', pricing({ inputPerMTok: 1, outputPerMTok: 5 }))), 2);
  });

  it('is zero for a free model and null when nothing is published', () => {
    assert.equal(blendedPerMTok(model('p', 'm', pricing({ kind: 'FREE' }))), 0);
    assert.equal(blendedPerMTok(model('p', 'm', pricing({ kind: 'METERED' }))), null);
  });
});

describe('route grouping', () => {
  const models = [
    model('cheapco', 'meta-llama/Llama-3.3-70B-Instruct', pricing({ inputPerMTok: 0.1, outputPerMTok: 0.3 })),
    model('pricey', 'llama-3.3-70b-instruct', pricing({ inputPerMTok: 2, outputPerMTok: 6 })),
    model('freeco', 'Llama-3.3-70B-Instruct:free', pricing({ kind: 'FREE' })),
    model('solo', 'some-unique-model', pricing({ inputPerMTok: 1, outputPerMTok: 1 })),
  ];

  it('groups the same model across providers', () => {
    const groups = groupRoutes(models, ctx());
    const llama = groups.find((g) => g.key === 'llama-3.3-70b-instruct');
    assert.ok(llama);
    assert.equal(llama.options.length, 3);
    assert.deepEqual(llama.options.map((o) => o.providerId).sort(), ['cheapco', 'freeco', 'pricey']);
  });

  it('keeps single-route models rather than hiding them', () => {
    const groups = groupRoutes(models, ctx());
    assert.ok(groups.find((g) => g.key === 'some-unique-model'), 'one way in is still an answer');
    assert.equal(multiRouteGroups(groups).length, 1);
  });

  it('picks the cheapest priced route', () => {
    const llama = groupRoutes(models, ctx()).find((g) => g.key === 'llama-3.3-70b-instruct')!;
    // freeco at 0 beats cheapco at 0.15.
    assert.equal(llama.cheapest?.providerId, 'freeco');
  });

  it('never calls an unpriced route the cheapest', () => {
    const groups = groupRoutes(
      [
        model('unknown', 'shared', pricing({ kind: 'METERED' })),
        model('known', 'shared', pricing({ inputPerMTok: 9, outputPerMTok: 9 })),
      ],
      ctx(),
    );
    const g = groups.find((x) => x.key === 'shared')!;
    // The unpriced one must not be treated as costing zero.
    assert.equal(g.cheapest?.providerId, 'known');
    assert.equal(g.options.find((o) => o.providerId === 'unknown')?.blendedPerMTok, null);
  });

  it('reports no cheapest at all when nothing publishes a price', () => {
    const g = groupRoutes([model('a', 'x', pricing()), model('b', 'x', pricing())], ctx()).find(
      (x) => x.key === 'x',
    )!;
    assert.equal(g.cheapest, null, 'silence is better than a fabricated winner');
  });

  it('picks fastest only from measured routes', () => {
    const perf = (modelId: string, p95: number) => ({
      modelId, ttftMs: null, latencyMs: p95, p95LatencyMs: p95, jitterMs: null,
      tokensPerSecond: null, uptime: null, samples: 5, updatedAt: 0,
    });
    const groups = groupRoutes(
      [model('slow', 'x', pricing()), model('fast', 'x', pricing()), model('unmeasured', 'x', pricing())],
      ctx({
        view: (id) =>
          id === 'slow:x'
            ? { model: model('slow', 'x', pricing()), scores: null, performance: perf(id, 900), status: 'ready' }
            : id === 'fast:x'
              ? { model: model('fast', 'x', pricing()), scores: null, performance: perf(id, 120), status: 'ready' }
              : null,
      }),
    );
    const g = groups.find((x) => x.key === 'x')!;
    assert.equal(g.fastest?.providerId, 'fast');
  });

  it('reports no fastest when nothing has been measured', () => {
    const g = groupRoutes([model('a', 'x', pricing()), model('b', 'x', pricing())], ctx()).find(
      (x) => x.key === 'x',
    )!;
    assert.equal(g.fastest, null);
  });

  it('prefers a usable free route over an unconfigured one', () => {
    const groups = groupRoutes(
      [
        model('nokey', 'x', pricing({ kind: 'FREE' })),
        model('haskey', 'x', pricing({ kind: 'FREE' })),
      ],
      ctx({ configured: (p) => p === 'haskey' }),
    );
    assert.equal(groups.find((g) => g.key === 'x')!.freeRoute?.providerId, 'haskey');
  });
});

describe('free radar', () => {
  const health = (state: ProviderHealth['state']): ProviderHealth => ({
    providerId: 'p', state, circuit: 'closed', consecutiveFailures: 0, successCount: 0,
    failureCount: 0, latencyMs: null, errorRate: 0, cooldownUntil: null,
    lastCheckedAt: null, lastErrorAt: null, lastError: null,
  });

  it('lists free routes and excludes paid ones', () => {
    const groups = groupRoutes(
      [
        model('freeco', 'a', pricing({ kind: 'FREE' })),
        model('paidco', 'b', pricing({ inputPerMTok: 5, outputPerMTok: 5 })),
      ],
      ctx(),
    );
    const entries = freeRadar(groups, { quality: () => 70 });
    assert.deepEqual(entries.map((e) => e.option.providerId), ['freeco']);
  });

  it('never lists trial credit as free', () => {
    const groups = groupRoutes([model('trialco', 'a', pricing({ kind: 'METERED' }))], ctx({
      freeAccess: () => 'TRIAL_CREDIT',
    }));
    assert.equal(freeRadar(groups, { quality: () => 90 }).length, 0, 'a finite balance is not free');
  });

  it('counts a zero-cost synced tier as free', () => {
    const groups = groupRoutes([model('quotaco', 'a', pricing({ kind: 'METERED' }))], ctx({
      freeAccess: () => 'FREE_DAILY_QUOTA',
    }));
    assert.equal(freeRadar(groups, { quality: () => 60 }).length, 1);
  });

  it('hides unconfigured routes unless asked, and then marks them', () => {
    const groups = groupRoutes([model('nokey', 'a', pricing({ kind: 'FREE' }))], ctx({ configured: () => false }));
    assert.equal(freeRadar(groups, { quality: () => 80 }).length, 0);

    const shown = freeRadar(groups, { quality: () => 80, includeUnconfigured: true });
    assert.equal(shown.length, 1);
    assert.match(shown[0]!.note, /API key/i);
  });

  it('ranks a healthy provider above a failing one at equal quality', () => {
    const groups = groupRoutes(
      [model('up', 'a', pricing({ kind: 'FREE' })), model('down', 'b', pricing({ kind: 'FREE' }))],
      ctx({ health: (p) => health(p === 'up' ? 'healthy' : 'offline') }),
    );
    const entries = freeRadar(groups, { quality: () => 70 });
    assert.equal(entries[0]?.option.providerId, 'up');
    assert.ok(entries[0]!.score > entries[1]!.score);
  });

  it('does not reward a model merely for never having been measured', () => {
    const groups = groupRoutes(
      [model('proven', 'a', pricing({ kind: 'FREE' })), model('untried', 'b', pricing({ kind: 'FREE' }))],
      ctx({
        health: () => health('healthy'),
        view: (id) =>
          id === 'proven:a'
            ? {
                model: model('proven', 'a', pricing({ kind: 'FREE' })),
                scores: { modelId: id, coding: null, reasoning: null, general: null, toolUse: null, vision: null, stability: 0.99, samples: 50, updatedAt: 0 },
                performance: null,
                status: 'ready' as const,
              }
            : null,
      }),
    );
    const entries = freeRadar(groups, { quality: () => 70 });
    // The proven one (0.99) must outrank the neutral prior (0.75).
    assert.equal(entries[0]?.option.providerId, 'proven');
  });

  it('shows the factors behind every score', () => {
    const groups = groupRoutes([model('a', 'm', pricing({ kind: 'FREE' }))], ctx());
    const e = freeRadar(groups, { quality: () => 80 })[0]!;
    assert.ok(e.factors.quality > 0);
    assert.ok(e.factors.reliability > 0);
    assert.ok(e.factors.availability > 0);
    assert.ok(e.score > 0 && e.score <= 100);
  });
});
