import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuggingFaceSource, OpenRouterSource, PollinationsSource, type DiscoveryContext } from '@meridian/model-sdk';

/**
 * The provider-native sources, against captured response shapes.
 *
 * These endpoints are unreachable from the machine this was written on — the
 * build environment reaches `raw.githubusercontent.com` and very little else,
 * so openrouter.ai, huggingface.co and pollinations.ai all fail at CONNECT.
 * That is a real limit and it is stated in docs/DISCOVERY.md rather than
 * papered over: what these tests prove is the parsing and the failure
 * behaviour, not that the live endpoints answer.
 *
 * The fixtures are the documented response shapes, trimmed. They are also
 * deliberately imperfect — a row with a missing rate, a provider that is not
 * live, an unexpected extra key — because the interesting question is not
 * "does it parse the happy path" but "what does it do with the response it did
 * not expect".
 */

const NOW = Date.parse('2026-09-09T00:00:00Z');

function context(fetchImpl: typeof fetch): { ctx: DiscoveryContext; cleanup: () => void } {
  const cacheDir = mkdtempSync(join(tmpdir(), 'meridian-native-'));
  return {
    ctx: { cacheDir, now: NOW, fetchImpl, timeoutMs: 5_000 },
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  };
}

function serve(byUrl: Record<string, unknown>, status = 200): typeof fetch {
  return (async (url: string) => {
    const body = byUrl[String(url)];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/* ------------------------------------------------------------------ */

describe('OpenRouter’s model listing', () => {
  const payload = {
    data: [
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        name: 'Llama 3.3 70B Instruct (free)',
        context_length: 65536,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        top_provider: { context_length: 65536, max_completion_tokens: 4096 },
        supported_parameters: ['tools', 'response_format'],
      },
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        context_length: 200000,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        pricing: { prompt: '0.000003', completion: '0.000015', request: '0' },
        top_provider: { context_length: 200000, max_completion_tokens: 64000 },
        supported_parameters: ['tools', 'reasoning', 'structured_outputs'],
      },
      {
        id: 'some/model-with-no-rate-card',
        context_length: 8192,
        architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        pricing: {},
        an_unexpected_new_field: 42,
      },
    ],
  };

  it('reads models, rates and limits', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': payload }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      assert.equal(snap.error, null);
      assert.equal(snap.models.length, 3);
      const free = snap.models.find((m) => m.providerModelId.endsWith(':free'));
      assert.equal(free?.pricing?.kind, 'FREE');
      assert.equal(free?.contextLength, 65536);
      assert.equal(free?.maxOutputTokens, 4096);
    } finally {
      cleanup();
    }
  });

  it('converts a per-token rate to Meridian’s per-million', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': payload }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      const paid = snap.models.find((m) => m.providerModelId === 'anthropic/claude-sonnet-4');
      // $0.000003/token is $3/M. Getting this factor wrong by 10^6 would make
      // every budget policy either useless or unusable, in silence.
      assert.equal(paid?.pricing?.inputPerMTok, 3);
      assert.equal(paid?.pricing?.outputPerMTok, 15);
      assert.equal(paid?.pricing?.kind, 'METERED');
    } finally {
      cleanup();
    }
  });

  it('records an unreadable rate as unknown rather than as zero', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': payload }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      const unknown = snap.models.find((m) => m.providerModelId === 'some/model-with-no-rate-card');
      assert.equal(unknown?.pricing?.kind, 'UNKNOWN');
      assert.equal(unknown?.pricing?.inputPerMTok, null);
      assert.notEqual(unknown?.pricing?.kind, 'FREE');
    } finally {
      cleanup();
    }
  });

  it('reads modality from the architecture rather than from the model’s name', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': payload }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      assert.equal(snap.models.find((m) => m.providerModelId === 'anthropic/claude-sonnet-4')?.capabilities?.vision, true);
      assert.equal(snap.models.find((m) => m.providerModelId === 'some/model-with-no-rate-card')?.capabilities?.imageGeneration, true);
      // Not mentioned is not denied: a model that does not list vision has not
      // been said to lack it, so the flag stays absent rather than false.
      assert.equal(snap.models.find((m) => m.providerModelId.endsWith(':free'))?.capabilities?.vision, undefined);
    } finally {
      cleanup();
    }
  });

  it('names the free models at the provider level without calling the provider free', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': payload }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      const intel = snap.providers[0].intelligence;
      assert.deepEqual(intel?.freeModelIds, ['meta-llama/llama-3.3-70b-instruct:free']);
      assert.match(intel?.caveat ?? '', /daily request cap/);
    } finally {
      cleanup();
    }
  });

  it('reports a response it does not recognise instead of throwing', async () => {
    const { ctx, cleanup } = context(serve({ 'https://openrouter.ai/api/v1/models': { error: { message: 'rate limited' } } }));
    try {
      const snap = await new OpenRouterSource().load(ctx);
      assert.equal(snap.models.length, 0);
      assert.match(snap.error ?? '', /Rejected the payload/);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Pollinations', () => {
  const urls = {
    'https://text.pollinations.ai/models': [
      { name: 'openai', description: 'OpenAI GPT-5 Nano', vision: true, tools: true, input_modalities: ['text', 'image'], output_modalities: ['text'] },
      { name: 'deepseek-reasoning', description: 'DeepSeek R1', reasoning: true },
    ],
    'https://image.pollinations.ai/models': ['flux', 'turbo', 'kontext'],
  };

  it('reads both endpoints and marks what each produces', async () => {
    const { ctx, cleanup } = context(serve(urls));
    try {
      const snap = await new PollinationsSource().load(ctx);
      assert.equal(snap.models.length, 5);
      assert.equal(snap.models.find((m) => m.providerModelId === 'openai')?.capabilities?.vision, true);
      assert.equal(snap.models.find((m) => m.providerModelId === 'flux')?.capabilities?.imageGeneration, true);
      assert.ok(snap.models.every((m) => m.pricing?.kind === 'FREE'));
    } finally {
      cleanup();
    }
  });

  it('keeps the endpoint that worked when the other does not', async () => {
    // Half a catalogue is worth having. Losing the text models because the
    // image endpoint is down would be a self-inflicted outage.
    const { ctx, cleanup } = context(serve({ 'https://text.pollinations.ai/models': urls['https://text.pollinations.ai/models'] }));
    try {
      const snap = await new PollinationsSource().load(ctx);
      assert.equal(snap.models.length, 2);
      assert.match(snap.error ?? '', /image\.pollinations/);
    } finally {
      cleanup();
    }
  });

  it('says what an anonymous public endpoint is worth', async () => {
    const { ctx, cleanup } = context(serve(urls));
    try {
      const snap = await new PollinationsSource().load(ctx);
      const intel = snap.providers[0].intelligence;
      assert.equal(intel?.freeAccess, 'ONGOING_FREE_TIER');
      assert.equal(intel?.requirements.apiKey, 'no');
      // The caveat is the point: free and dependable are different properties.
      assert.match(intel?.caveat ?? '', /no commitment that it will be there tomorrow/);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Hugging Face’s router', () => {
  const payload = {
    data: [
      {
        id: 'deepseek-ai/DeepSeek-V3-0324',
        owned_by: 'deepseek-ai',
        providers: [
          { provider: 'novita', status: 'live', context_length: 163840, supports_tools: true },
          { provider: 'sambanova', status: 'live', context_length: 32768 },
        ],
      },
      { id: 'some/retired-model', providers: [{ provider: 'x', status: 'staging', context_length: 4096 }] },
      { id: 'some/model-with-no-providers', providers: [] },
    ],
  };

  it('takes the largest context any live provider offers', async () => {
    const { ctx, cleanup } = context(serve({ 'https://router.huggingface.co/v1/models': payload }));
    try {
      const snap = await new HuggingFaceSource().load(ctx);
      assert.equal(snap.models.length, 1, 'models with no live provider are not routes');
      assert.equal(snap.models[0].contextLength, 163840);
      assert.equal(snap.models[0].capabilities?.tools, true);
    } finally {
      cleanup();
    }
  });

  it('does not call a monthly credit a free tier', async () => {
    // The taxonomy has RECURRING_CREDIT precisely so this does not get rounded
    // to "free": the credit runs out, and then the calls cost money.
    const { ctx, cleanup } = context(serve({ 'https://router.huggingface.co/v1/models': payload }));
    try {
      const snap = await new HuggingFaceSource().load(ctx);
      const intel = snap.providers[0].intelligence;
      assert.equal(intel?.freeAccess, 'RECURRING_CREDIT');
      assert.equal(snap.models[0].pricing?.kind, 'UNKNOWN', 'a third-party rate Meridian cannot see is unknown, not zero');
      assert.match(intel?.caveat ?? '', /not a zero-cost route/);
    } finally {
      cleanup();
    }
  });
});
