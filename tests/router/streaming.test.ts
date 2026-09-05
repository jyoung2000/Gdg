import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MeridianError, isMeridianError, nullLogger } from '@meridian/shared';
import { OpenAICompatibleAdapter, sseLines } from '@meridian/provider-sdk';

/** A server that sends SSE headers, one frame, then goes silent forever. */
async function startStallingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
    // Then nothing: headers arrived, so the request-level deadline is already
    // spent, and the body never ends.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Stream safety', () => {
  it('abandons a stalled stream on the idle deadline instead of hanging', async () => {
    const s = await startStallingServer();
    const res = await fetch(`${s.url}/chat/completions`, { method: 'POST' });

    const seen: string[] = [];
    await assert.rejects(
      async () => {
        for await (const frame of sseLines(res, { idleTimeoutMs: 250, providerId: 'stall' })) seen.push(frame);
      },
      (e: unknown) => isMeridianError(e) && e.code === 'timeout',
      'a stream that goes silent must fail, not block forever',
    );
    assert.equal(seen.length, 1, 'frames received before the stall are still delivered');
    await s.close();
  });

  it('stops a stream promptly when the caller aborts', async () => {
    const s = await startStallingServer();
    const res = await fetch(`${s.url}/chat/completions`, { method: 'POST' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60).unref?.();

    await assert.rejects(
      async () => {
        for await (const _frame of sseLines(res, { signal: ac.signal, idleTimeoutMs: 30_000 })) {
          /* drain */
        }
      },
      (e: unknown) => isMeridianError(e) && e.code === 'cancelled',
    );
    await s.close();
  });

  it('an adapter that does not stream still yields a well-formed chunk sequence', async () => {
    const { startMockProvider } = await import('../helpers/mock-provider.js');
    const mock = await startMockProvider('nostream', { reply: 'hello there' });
    const adapter = new OpenAICompatibleAdapter(mock.descriptor, { supports: { chat: true, streaming: false } });

    const chunks: string[] = [];
    for await (const c of adapter.chatStream(
      { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
      { secret: null, logger: nullLogger, requestId: 'r', timeoutMs: 5000 },
    )) {
      chunks.push(c.type);
    }
    // Degrading gracefully means the caller still sees start/text/usage/done.
    assert.deepEqual(chunks, ['start', 'text', 'usage', 'done']);
    await mock.close();
  });
});
