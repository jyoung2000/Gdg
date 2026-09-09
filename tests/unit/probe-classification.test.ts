import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MeridianError } from '@meridian/shared';
import { classify, probeCapability } from '@meridian/provider-sdk';
import type { ModelDescriptor } from '@meridian/shared';
import type { AdapterContext, ProviderAdapter } from '@meridian/provider-sdk';

/**
 * What a failed capability probe is allowed to conclude.
 *
 * This is the one function that decides whether a false negative gets written
 * into the model registry, where it stays: a capability recorded as
 * `unsupported` stops the model being routed for that work until someone
 * re-verifies it by hand. Everything about it should refuse to guess.
 */
describe('Probe classification', () => {
  it('never turns a condition into a claim', () => {
    // Rate limits, timeouts, outages and expired keys are facts about the
    // moment, not about the model.
    for (const code of ['rate_limited', 'timeout', 'server_error', 'provider_unavailable', 'authentication_failed', 'quota_exhausted'] as const) {
      const verdict = classify(new MeridianError(code, `provider said ${code}`));
      assert.equal(verdict.outcome, 'inconclusive', `${code} became a claim about the model`);
    }
  });

  it('does not read a retired model id as a missing capability', () => {
    // A 404 says the provider does not serve this id — which says nothing
    // about what the model can do. Read as a refusal it deleted a capability
    // from the registry every time a provider retired an id.
    const verdict = classify(new MeridianError('model_unavailable', 'The model `gpt-4-0301` does not exist'));
    assert.equal(verdict.outcome, 'inconclusive');
  });

  it('does not read a refusal of its own parameters as a refusal of the capability', () => {
    // Reasoning models reject `temperature` with the same code, and nearly the
    // same words, that a text-only model uses to reject an image.
    for (const message of [
      "Unsupported parameter: 'temperature' is not supported with this model.",
      "Unsupported value: 'max_tokens' — use 'max_completion_tokens' instead.",
    ]) {
      const verdict = classify(new MeridianError('invalid_request', message));
      assert.equal(verdict.outcome, 'parameter-refused', `"${message}" was read as a capability answer`);
    }
  });

  it('still reads a genuine capability refusal as one', () => {
    assert.equal(classify(new MeridianError('invalid_request', 'this model does not support image input')).outcome, 'unsupported');
    assert.equal(classify(new MeridianError('unsupported_capability', 'tool use is not available here')).outcome, 'unsupported');
    // And a phrase-matched refusal inside an otherwise generic error.
    assert.equal(classify(new MeridianError('server_error', 'The model is not multimodal')).outcome, 'unsupported');
  });

  it('will not loop on a provider that always blames a parameter', () => {
    // The second pass has already dropped the optional parameters, so the same
    // complaint cannot be a request to drop them again.
    const verdict = classify(new MeridianError('invalid_request', "Unsupported parameter: 'temperature'"), false);
    assert.notEqual(verdict.outcome, 'parameter-refused');
  });
});

/* ------------------------------------------------------------------ */

const model = {
  id: 'p:m',
  providerId: 'p',
  providerModelId: 'm',
  displayName: 'm',
  capabilities: ['text'],
} as unknown as ModelDescriptor;

const ctx = { secret: null, logger: { child: () => ctx.logger, info() {}, warn() {}, error() {}, debug() {} }, requestId: 'r', timeoutMs: 1000 } as unknown as AdapterContext;

describe('Probing a model that refuses the probe’s own parameters', () => {
  it('asks again without them and reports what that answered', async () => {
    const seen: Record<string, unknown>[] = [];
    const adapter = {
      descriptor: { id: 'p', auth: 'none' },
      chat: async (req: Record<string, unknown>) => {
        seen.push(req);
        if ('temperature' in req) throw new MeridianError('invalid_request', "Unsupported parameter: 'temperature'");
        return { content: 'ok', toolCalls: [], usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cost: 0 } };
      },
    } as unknown as ProviderAdapter;

    const result = await probeCapability(adapter, model, 'text', ctx);
    assert.equal(result.outcome, 'supported', `the retry did not happen or did not count: ${result.detail}`);
    assert.equal(seen.length, 2, 'the probe was not re-sent');
    assert.ok('temperature' in seen[0], 'the first attempt should carry the optional parameters');
    assert.ok(!('temperature' in seen[1]) && !('maxTokens' in seen[1]), 'the second attempt should carry none of them');
  });

  it('reports inconclusive rather than unsupported when the retry fails for another reason', async () => {
    const adapter = {
      descriptor: { id: 'p', auth: 'none' },
      chat: async (req: Record<string, unknown>) => {
        if ('temperature' in req) throw new MeridianError('invalid_request', "Unsupported parameter: 'temperature'");
        throw new MeridianError('rate_limited', 'slow down');
      },
    } as unknown as ProviderAdapter;

    const result = await probeCapability(adapter, model, 'text', ctx);
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.detail, /after retrying without/);
  });
});
