import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODALITIES,
  NON_SPENDING_PRICING,
  ROUTING_MODES,
  isMeridianError,
  type Capability,
  type Modality,
  type Pricing,
  type PrivacyMode,
  type RoutingMode,
} from '@meridian/shared';
import { FREE, LOCAL, PAID, createHarness, model } from '../helpers/harness.js';
import { startMockProvider, type MockProvider } from '../helpers/mock-provider.js';

/**
 * Properties the router must hold for every registry it is given.
 *
 * The example-based tests fix one registry and check one outcome. These
 * generate hundreds of registries and requests from a seeded sequence and
 * assert what must be true of *every* decision — the guarantees a user is
 * relying on when they turn paid routing off, pick STRICT_LOCAL, or set a
 * budget. A property that only holds for the registries someone thought to
 * write down is not a guarantee.
 *
 * The generator is seeded, so a failure names an input that reproduces exactly.
 */

/** Mulberry32: small, seeded, and identical run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICINGS: Pricing[] = [
  FREE,
  PAID,
  LOCAL,
  { kind: 'FREE_DAILY', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: '50 a day' },
  { kind: 'TRIAL', inputPerMTok: 0, outputPerMTok: 0, perRequest: null, note: '$5 of credit' },
  { kind: 'METERED', inputPerMTok: 0.2, outputPerMTok: 0.4, perRequest: null, note: null },
];

const CAPABILITY_SETS: Capability[][] = [
  ['text'],
  ['text', 'streaming'],
  ['text', 'streaming', 'tools'],
  ['text', 'streaming', 'tools', 'vision'],
  ['embedding'],
  ['image-generation'],
];

const MODALITY_SETS: Modality[][] = [['text'], ['text', 'vision'], ['embedding'], ['image'], ['audio']];

interface Scenario {
  seed: number;
  harness: ReturnType<typeof createHarness>;
  request: {
    modality: Modality;
    taskType: 'chat' | 'coding' | 'image-generation' | 'embedding';
    mode: RoutingMode;
    privacyMode: PrivacyMode;
    allowPaid: boolean;
    budget: number | null;
    toolsRequired: boolean;
  };
}

function scenario(seed: number, providers: MockProvider[]): Scenario {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];

  const chosen = providers.slice(0, 1 + Math.floor(rand() * providers.length));
  const descriptors = chosen.map((p, i) => ({
    ...p.descriptor,
    local: rand() < 0.3,
    trust: pick(['verified', 'trusted', 'unknown', 'untrusted'] as const),
    id: `${p.descriptor.id}-${i}`,
  }));

  const models = descriptors.flatMap((d) => {
    const count = 1 + Math.floor(rand() * 3);
    return Array.from({ length: count }, (_, n) => {
      const pricing = d.local ? LOCAL : pick(PRICINGS);
      return model({
        id: `${d.id}:m${n}`,
        providerId: d.id,
        providerModelId: `m${n}`,
        modalities: pick(MODALITY_SETS),
        capabilities: pick(CAPABILITY_SETS),
        pricing,
        contextLength: pick([4096, 32_768, 200_000]),
      });
    });
  });

  const harness = createHarness({ providers: descriptors, models, allowPaid: rand() < 0.5 });

  return {
    seed,
    harness,
    request: {
      modality: pick(MODALITIES.filter((m) => m !== 'video' && m !== 'speech') as Modality[]),
      taskType: pick(['chat', 'coding', 'image-generation', 'embedding'] as const),
      mode: pick(ROUTING_MODES),
      privacyMode: pick(['STRICT_LOCAL', 'TRUSTED_ONLY', 'FREE_PROVIDERS', 'ANY_PROVIDER'] as const),
      allowPaid: rand() < 0.5,
      budget: rand() < 0.3 ? Number((rand() * 0.01).toFixed(6)) : null,
      toolsRequired: rand() < 0.4,
    },
  };
}

describe('Router invariants', async () => {
  const providers = await Promise.all([startMockProvider('p1'), startMockProvider('p2'), startMockProvider('p3')]);
  const RUNS = 400;

  const decisions: { s: Scenario; decision: ReturnType<Scenario['harness']['router']['route']> }[] = [];
  const refusals: Scenario[] = [];
  for (let seed = 1; seed <= RUNS; seed++) {
    const s = scenario(seed, providers);
    try {
      decisions.push({ s, decision: s.harness.router.route(s.request) });
    } catch (e) {
      assert.ok(isMeridianError(e), `seed ${seed}: the router threw something that is not a MeridianError: ${String(e)}`);
      assert.equal(e.code, 'no_candidates', `seed ${seed}: an unroutable request must say so, not fail as ${e.code}`);
      refusals.push(s);
    }
  }

  it('exercises both outcomes, so the properties below are not vacuous', () => {
    assert.ok(decisions.length > 40, `expected many routable scenarios, saw ${decisions.length}`);
    assert.ok(refusals.length > 5, `expected some unroutable ones, saw ${refusals.length}`);
  });

  it('never selects a model that cannot serve the requested modality', () => {
    for (const { s, decision } of decisions) {
      const chosen = s.harness.models.get(`${decision.provider}:${decision.model}`);
      assert.ok(chosen, `seed ${s.seed}: selected a model that is not registered`);
      assert.ok(
        chosen.modalities.includes(s.request.modality),
        `seed ${s.seed}: ${chosen.id} serves ${chosen.modalities.join(',')} but was chosen for ${s.request.modality}`,
      );
    }
  });

  it('never spends money unless the request and the instance both allow it', () => {
    for (const { s, decision } of decisions) {
      const chosen = s.harness.models.get(`${decision.provider}:${decision.model}`)!;
      const spends = !NON_SPENDING_PRICING.includes(chosen.pricing.kind);
      if (!s.request.allowPaid) {
        assert.ok(!spends, `seed ${s.seed}: chose ${chosen.pricing.kind} model ${chosen.id} without permission to spend`);
        assert.equal(decision.expectedCost, 0, `seed ${s.seed}: a free-only request must have no expected cost`);
      }
    }
  });

  it('honours a budget rather than exceeding it quietly', () => {
    for (const { s, decision } of decisions) {
      if (s.request.budget === null) continue;
      assert.ok(
        decision.expectedCost <= s.request.budget,
        `seed ${s.seed}: expected cost ${decision.expectedCost} exceeds the budget ${s.request.budget}`,
      );
    }
  });

  it('keeps a STRICT_LOCAL request on the machine, including its fallbacks', () => {
    for (const { s, decision } of decisions) {
      if (s.request.privacyMode !== 'STRICT_LOCAL') continue;
      const local = (providerId: string) => s.harness.providers.descriptor(providerId)?.local === true;
      assert.ok(local(decision.provider), `seed ${s.seed}: STRICT_LOCAL chose the remote provider ${decision.provider}`);
      for (const step of decision.fallbackChain) {
        assert.ok(local(step.provider), `seed ${s.seed}: STRICT_LOCAL would fail over to the remote provider ${step.provider}`);
      }
    }
  });

  it('keeps a FREE-mode request on capacity that cannot charge, including its fallbacks', () => {
    for (const { s, decision } of decisions) {
      if (s.request.mode !== 'FREE') continue;
      for (const target of [{ provider: decision.provider, model: decision.model }, ...decision.fallbackChain]) {
        const m = s.harness.models.get(`${target.provider}:${target.model}`)!;
        assert.ok(
          NON_SPENDING_PRICING.includes(m.pricing.kind),
          `seed ${s.seed}: FREE mode included ${m.id}, priced ${m.pricing.kind}`,
        );
      }
    }
  });

  it('supplies tool support whenever the request needs it', () => {
    for (const { s, decision } of decisions) {
      if (!s.request.toolsRequired) continue;
      const chosen = s.harness.models.get(`${decision.provider}:${decision.model}`)!;
      assert.ok(chosen.capabilities.includes('tools'), `seed ${s.seed}: ${chosen.id} cannot call tools`);
      for (const step of decision.fallbackChain) {
        const alt = s.harness.models.get(`${step.provider}:${step.model}`)!;
        assert.ok(alt.capabilities.includes('tools'), `seed ${s.seed}: fallback ${alt.id} cannot call tools`);
      }
    }
  });

  it('builds a fallback chain of distinct targets that excludes the primary', () => {
    for (const { s, decision } of decisions) {
      const primary = `${decision.provider}:${decision.model}`;
      const seen = new Set<string>();
      for (const step of decision.fallbackChain) {
        const key = `${step.provider}:${step.model}`;
        assert.notEqual(key, primary, `seed ${s.seed}: the primary appears in its own fallback chain`);
        assert.ok(!seen.has(key), `seed ${s.seed}: ${key} appears twice in the fallback chain`);
        seen.add(key);
      }
      // Diversify by provider first: retrying the provider that just refused is
      // the least likely alternate to behave differently, so every new provider
      // must be exhausted before any repeat. A same-provider alternate is a
      // legitimate last resort, never a first choice.
      const providersSeen = new Set([decision.provider]);
      let repeated = false;
      for (const step of decision.fallbackChain) {
        const isRepeat = providersSeen.has(step.provider);
        if (isRepeat) repeated = true;
        else {
          assert.ok(
            !repeated,
            `seed ${s.seed}: ${step.provider} is a new provider but comes after a repeat of one already tried`,
          );
          providersSeen.add(step.provider);
        }
      }
      // So if any alternate provider is in the chain at all, it comes first.
      const alternate = decision.fallbackChain.find((step) => step.provider !== decision.provider);
      if (alternate) {
        assert.notEqual(
          decision.fallbackChain[0].provider,
          decision.provider,
          `seed ${s.seed}: an alternate provider was available but the chain retries the failing one first`,
        );
      }
    }
  });

  it('explains every decision, and every candidate it dropped', () => {
    for (const { s, decision } of decisions) {
      const reason = decision.routingReason;
      assert.ok(reason.summary.trim().length > 10, `seed ${s.seed}: the summary says nothing`);
      assert.ok(reason.criteria.length > 0, `seed ${s.seed}: no criteria were reported`);
      assert.ok(ROUTING_MODES.includes(reason.mode), `seed ${s.seed}: reported an unknown mode ${reason.mode}`);
      assert.equal(reason.requestedMode, s.request.mode, `seed ${s.seed}: the decision must echo the mode that was asked for`);
      for (const dropped of reason.rejected) {
        assert.ok(dropped.reason.trim().length > 0, `seed ${s.seed}: ${dropped.modelId} was dropped without a reason`);
      }
      // The winner must appear in what was considered, or the ranking shown to
      // the user does not describe the choice that was made.
      assert.ok(
        reason.considered.some((c) => c.modelId === `${decision.provider}:${decision.model}`),
        `seed ${s.seed}: the chosen model is absent from the candidates it was chosen among`,
      );
    }
  });

  it('says why nothing matched, rather than failing blankly', () => {
    for (const s of refusals) {
      try {
        s.harness.router.route(s.request);
        assert.fail(`seed ${s.seed}: expected a refusal`);
      } catch (e) {
        assert.ok(isMeridianError(e));
        assert.ok(e.message.length > 30, `seed ${s.seed}: the refusal explains nothing: "${e.message}"`);
        assert.match(e.message, new RegExp(s.request.modality), `seed ${s.seed}: the refusal should name what was asked for`);
      }
    }
  });

  it('is deterministic: the same registry and request give the same decision', () => {
    for (const { s, decision } of decisions.slice(0, 60)) {
      const again = s.harness.router.route(s.request);
      assert.equal(again.provider, decision.provider, `seed ${s.seed}: routing is not deterministic`);
      assert.equal(again.model, decision.model, `seed ${s.seed}: routing is not deterministic`);
    }
  });

  it('closes its mock providers', async () => {
    await Promise.all(providers.map((p) => p.close()));
  });
});
