import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nullLogger } from '@meridian/shared';
import { AnthropicAdapter, PROVIDER_CATALOG } from '@meridian/provider-sdk';
import { createHarness, model } from '../helpers/harness.js';
import { startMockProvider, type MockProvider } from '../helpers/mock-provider.js';

/**
 * Does the reasoning-effort control actually reach the provider — and only the
 * providers that can use it?
 *
 * A control that does not change the request that leaves the building is
 * theatre, so these tests inspect the exact body each provider receives rather
 * than trusting a return value. The mock provider records every request body
 * over a real socket, which is the strongest form the claim can take: this is
 * what the model server saw.
 */
describe('Reasoning effort reaches the provider', () => {
  let provider: MockProvider;

  before(async () => {
    provider = await startMockProvider('alpha', { reply: 'ok' });
  });
  after(async () => {
    await provider.close();
  });

  const lastChatBody = (): Record<string, unknown> => {
    const call = [...provider.calls].reverse().find((c) => c.path.includes('/chat/completions'));
    assert.ok(call, 'the provider received a chat request');
    return call.body as Record<string, unknown>;
  };

  it('sends reasoning_effort to a reasoning-capable model', async () => {
    const h = createHarness({
      providers: [provider.descriptor],
      models: [
        model({
          id: 'alpha:thinker',
          providerId: 'alpha',
          providerModelId: 'thinker',
          capabilities: ['text', 'streaming', 'tools', 'reasoning'],
        }),
      ],
    });

    await h.executor.chat(
      { modality: 'text', taskType: 'chat', model: 'alpha:thinker' },
      { messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high' },
    );

    assert.equal(lastChatBody().reasoning_effort, 'high', 'the reasoning model received the effort verbatim');
  });

  it('drops reasoning_effort for a model that does not reason', async () => {
    const h = createHarness({
      providers: [provider.descriptor],
      models: [
        model({
          id: 'alpha:plain',
          providerId: 'alpha',
          providerModelId: 'plain',
          // No 'reasoning' capability: the gate must strip the parameter so the
          // provider is never handed something it would reject.
          capabilities: ['text', 'streaming', 'tools'],
        }),
      ],
    });

    await h.executor.chat(
      { modality: 'text', taskType: 'chat', model: 'alpha:plain' },
      { messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high' },
    );

    assert.equal('reasoning_effort' in lastChatBody(), false, 'a non-reasoning model was not sent the effort parameter');
  });

  it('sends nothing when no effort is requested', async () => {
    const h = createHarness({
      providers: [provider.descriptor],
      models: [model({ id: 'alpha:thinker', providerId: 'alpha', providerModelId: 'thinker', capabilities: ['text', 'reasoning'] })],
    });
    await h.executor.chat(
      { modality: 'text', taskType: 'chat', model: 'alpha:thinker' },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    assert.equal('reasoning_effort' in lastChatBody(), false, 'the field is absent unless asked for');
  });
});

/**
 * Anthropic does not take an enum — it takes a thinking token budget, and the
 * request must obey three of its rules at once. A single passthrough would have
 * broken all three, so the translation is tested against a real Anthropic-shaped
 * endpoint that captures the body.
 */
describe('Anthropic effort becomes a thinking budget', () => {
  let server: Server;
  let received: Record<string, unknown> | null = null;
  let baseUrl = '';

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            model: 'claude',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const descriptor = PROVIDER_CATALOG.find((d) => d.id === 'anthropic')!;
  const ctx = { secret: 'test-key', baseUrl: '', logger: nullLogger, requestId: 'r', timeoutMs: 5000 };

  it('maps a level to a budget, lifts max_tokens above it, and drops sampling params', async () => {
    received = null;
    const adapter = new AnthropicAdapter(descriptor);
    await adapter.chat(
      {
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hello' }],
        // These two must not survive: Anthropic rejects a thinking request that
        // also sets temperature or top_p.
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1000,
        reasoningEffort: 'medium',
      },
      { ...ctx, baseUrl },
    );

    assert.ok(received, 'the endpoint received a request');
    const body: Record<string, unknown> = received;
    const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
    assert.equal(thinking?.type, 'enabled', 'thinking was enabled');
    assert.equal(thinking?.budget_tokens, 10_000, 'medium maps to the 10k budget');
    assert.ok((body.max_tokens as number) > 10_000, 'max_tokens was lifted above the thinking budget');
    assert.equal('temperature' in body, false, 'temperature was dropped for the thinking request');
    assert.equal('top_p' in body, false, 'top_p was dropped for the thinking request');
  });

  it('leaves sampling params in place when no effort is set', async () => {
    received = null;
    const adapter = new AnthropicAdapter(descriptor);
    await adapter.chat(
      { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 },
      { ...ctx, baseUrl },
    );
    assert.ok(received, 'the endpoint received a request');
    const body: Record<string, unknown> = received;
    assert.equal('thinking' in body, false, 'no thinking block without a requested effort');
    assert.equal(body.temperature, 0.5, 'temperature is honoured normally');
  });
});
