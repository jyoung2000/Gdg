import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, estimateTokens, formatCost, isFree, mayCharge, type Pricing } from '@meridian/shared';
import { PROVIDER_CATALOG, openRouterPricing } from '@meridian/provider-sdk';
import { inferFromName, enrich } from '@meridian/model-sdk';

const pricing = (over: Partial<Pricing> & Pick<Pricing, 'kind'>): Pricing => ({
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note: null,
  ...over,
});

describe('Pricing honesty', () => {
  it('never treats a trial or promotional credit as permanently free', () => {
    // This is the mislabelling the product explicitly forbids: credits expire,
    // and calling them "free" tells the operator something untrue about cost.
    for (const kind of ['TRIAL', 'CREDIT'] as const) {
      assert.equal(isFree(pricing({ kind })), false, `${kind} must not be reported as free`);
      assert.equal(mayCharge(pricing({ kind })), true);
    }
  });

  it('treats only structurally non-spending kinds as free', () => {
    for (const kind of ['FREE', 'FREE_DAILY', 'FREE_MONTHLY', 'LOCAL'] as const) {
      assert.equal(isFree(pricing({ kind })), true, `${kind} should be free`);
      assert.equal(computeCost(pricing({ kind, inputPerMTok: 99, outputPerMTok: 99 }), 1_000_000, 1_000_000), 0);
    }
  });

  it('treats an all-zero metered model as free, because it cannot charge', () => {
    assert.equal(isFree(pricing({ kind: 'METERED', inputPerMTok: 0, outputPerMTok: 0, perRequest: 0 })), true);
    assert.equal(isFree(pricing({ kind: 'METERED', inputPerMTok: 0.0001, outputPerMTok: 0 })), false);
  });

  it('treats unknown pricing as chargeable rather than assuming it is free', () => {
    // Guessing "free" here would let a request spend money without permission.
    assert.equal(isFree(pricing({ kind: 'UNKNOWN' })), false);
    assert.equal(mayCharge(pricing({ kind: 'UNKNOWN' })), true);
  });

  it('computes token cost correctly', () => {
    const p = pricing({ kind: 'METERED', inputPerMTok: 3, outputPerMTok: 15 });
    assert.equal(computeCost(p, 1_000_000, 0), 3);
    assert.equal(computeCost(p, 0, 1_000_000), 15);
    assert.equal(computeCost(p, 500_000, 100_000), 3);
    assert.equal(computeCost(p, 0, 0), 0);
  });

  it('computes per-request cost for image-style billing', () => {
    const p = pricing({ kind: 'METERED', perRequest: 0.04 });
    assert.equal(computeCost(p, 0, 0, 1), 0.04);
    assert.equal(computeCost(p, 0, 0, 4), 0.16);
  });

  it('formats cost with enough precision to be useful below a cent', () => {
    assert.equal(formatCost(0), '$0.00');
    assert.equal(formatCost(0.00042), '$0.0004');
    assert.equal(formatCost(0.125), '$0.125');
    assert.equal(formatCost(12.5), '$12.50');
  });

  it('estimates tokens from characters conservatively', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('hello world') > 0);
    // Longer text must estimate higher; the exact ratio is a heuristic.
    assert.ok(estimateTokens('x'.repeat(4000)) > estimateTokens('x'.repeat(400)));
  });
});

describe('OpenRouter pricing parsing', () => {
  it('marks a zero-priced route free, from the provider’s own published data', () => {
    const p = openRouterPricing({ pricing: { prompt: '0', completion: '0', request: '0', image: '0' } });
    assert.equal(p.kind, 'FREE');
    assert.equal(isFree(p), true);
    assert.match(p.note ?? '', /rate limited/i);
  });

  it('converts per-token strings into per-million rates', () => {
    const p = openRouterPricing({ pricing: { prompt: '0.000003', completion: '0.000015' } });
    assert.equal(p.kind, 'METERED');
    assert.ok(Math.abs((p.inputPerMTok ?? 0) - 3) < 1e-6);
    assert.ok(Math.abs((p.outputPerMTok ?? 0) - 15) < 1e-6);
  });

  it('does not invent a rate when the provider published none', () => {
    const p = openRouterPricing({});
    assert.equal(p.inputPerMTok, null);
    assert.equal(p.outputPerMTok, null);
  });
});

describe('Provider catalog integrity', () => {
  it('has unique ids and a base URL for every entry', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique');
    for (const p of PROVIDER_CATALOG) {
      assert.ok(p.baseUrl.startsWith('http'), `${p.id} needs a base URL`);
      assert.ok(p.name.length > 0);
      assert.ok(p.kinds.length > 0);
    }
  });

  it('never claims to know a data-use policy it has not verified', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.local) continue;
      // A remote provider's policy is the provider's to state, not ours to
      // assume, so the shipped catalog says "unknown" and links the source.
      assert.equal(p.dataUse.trainingUse, 'unknown', `${p.id} must not claim a training-use answer`);
      assert.equal(p.dataUse.commercialUse, 'unknown', `${p.id} must not claim a commercial-use answer`);
      assert.ok(p.dataUse.policyUrl, `${p.id} must link to the provider's own policy`);
    }
  });

  it('states the structural answer for local providers', () => {
    for (const p of PROVIDER_CATALOG.filter((x) => x.local)) {
      assert.equal(p.dataUse.trainingUse, 'not_allowed');
      assert.equal(p.defaultPricing.kind, 'LOCAL');
      assert.equal(p.trust, 'verified');
      assert.equal(p.auth, 'none');
    }
  });

  it('labels rate-limited free tiers as FREE_DAILY, not FREE', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.defaultPricing.kind !== 'FREE') continue;
      // Only genuinely keyless or crowd-powered services are plain FREE.
      assert.ok(['pollinations', 'ai-horde'].includes(p.id), `${p.id} claims plain FREE; it should be FREE_DAILY with a note`);
    }
    const groq = PROVIDER_CATALOG.find((p) => p.id === 'groq')!;
    assert.equal(groq.defaultPricing.kind, 'FREE_DAILY');
    assert.match(groq.defaultPricing.note ?? '', /not unlimited/i);
  });

  it('marks pay-per-use providers as metered with no invented rates', () => {
    for (const id of ['fal', 'replicate']) {
      const p = PROVIDER_CATALOG.find((x) => x.id === id)!;
      assert.equal(p.defaultPricing.kind, 'METERED');
      assert.equal(p.defaultPricing.inputPerMTok, null);
      assert.match(p.notes ?? '', /no free tier/i);
    }
  });

  it('flags keyless public endpoints as unsuitable for private data', () => {
    for (const id of ['pollinations', 'ai-horde']) {
      const p = PROVIDER_CATALOG.find((x) => x.id === id)!;
      assert.equal(p.trust, 'unknown');
      assert.match(p.dataUse.privacyNote ?? '', /(public|private|sensitive)/i);
    }
  });
});

describe('Capability inference', () => {
  it('recognises vision, coding, reasoning, image, video and audio families', () => {
    assert.ok(inferFromName('llava-13b').capabilities.includes('vision'));
    assert.ok(inferFromName('qwen2.5-coder-32b').tags.includes('coding'));
    assert.ok(inferFromName('deepseek-r1').capabilities.includes('reasoning'));
    assert.ok(inferFromName('flux.1-schnell').capabilities.includes('image-generation'));
    assert.ok(inferFromName('ltx-video').capabilities.includes('video-generation'));
    assert.ok(inferFromName('whisper-large-v3').capabilities.includes('transcription'));
    assert.ok(inferFromName('text-embedding-3-small').capabilities.includes('embedding'));
  });

  it('reads a context window encoded in the model name', () => {
    assert.equal(inferFromName('mixtral-8x7b-32k').contextLength, 32 * 1024);
    assert.equal(inferFromName('some-model-1m').contextLength, 1_000_000);
    assert.equal(inferFromName('plain-model').contextLength, null);
  });

  it('reports when nothing matched, so the guess can be treated as weak', () => {
    assert.equal(inferFromName('totally-unknown-thing').matched, false);
  });

  it('does not turn a dedicated image model into a text model', () => {
    const enriched = enrich({
      id: 'p:flux-schnell',
      providerId: 'p',
      providerModelId: 'flux-schnell',
      displayName: 'flux-schnell',
      family: null,
      // The generic listing shape defaults everything to text.
      modalities: ['text'],
      capabilities: ['text'],
      contextLength: null,
      maxOutputTokens: null,
      pricing: pricing({ kind: 'FREE' }),
      discovered: true,
      deprecated: false,
      tags: [],
      updatedAt: 0,
    });
    assert.deepEqual(enriched.modalities, ['image']);
    assert.equal(enriched.modalities.includes('text'), false, 'an image model must not be routable for chat');
  });

  it('keeps text alongside vision for a multimodal chat model', () => {
    const enriched = enrich({
      id: 'p:llava',
      providerId: 'p',
      providerModelId: 'llava-1.6',
      displayName: 'llava',
      family: null,
      modalities: ['text'],
      capabilities: ['text'],
      contextLength: null,
      maxOutputTokens: null,
      pricing: pricing({ kind: 'FREE' }),
      discovered: true,
      deprecated: false,
      tags: [],
      updatedAt: 0,
    });
    assert.ok(enriched.modalities.includes('text'));
    assert.ok(enriched.modalities.includes('vision'));
  });

  it('never overwrites a capability the provider stated directly', () => {
    const enriched = enrich({
      id: 'p:m',
      providerId: 'p',
      providerModelId: 'plain-model',
      displayName: 'm',
      family: null,
      modalities: ['text'],
      capabilities: ['text', 'tools'],
      contextLength: 128_000,
      maxOutputTokens: null,
      pricing: pricing({ kind: 'FREE' }),
      discovered: true,
      deprecated: false,
      tags: [],
      updatedAt: 0,
    });
    assert.equal(enriched.contextLength, 128_000);
    assert.ok(enriched.capabilities.includes('tools'));
  });
});
