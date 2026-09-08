import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderDescriptor } from '@meridian/shared';

export interface MockBehaviour {
  /** Fixed latency before responding, ms. */
  latencyMs?: number;
  /** Return 429 after this many successful calls. */
  rateLimitAfter?: number;
  /** Retry-After seconds sent with a 429. */
  retryAfterSec?: number;
  /** Fail this fraction of calls with a 500, deterministically by call index. */
  failEvery?: number;
  /** Never respond, so the client's timeout fires. */
  hang?: boolean;
  /** Always answer with this HTTP status. */
  alwaysStatus?: number;
  /** Require this exact bearer token; anything else gets a 401. */
  requireToken?: string;
  /** Model ids the listing endpoint reports. */
  models?: string[];
  /** Text the chat endpoint returns. */
  reply?: string;
  /** Emit a tool call instead of text. */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** Token counts reported back, for cost accounting assertions. */
  usage?: { prompt: number; completion: number };
  /**
   * Rate-limit headers sent with every response.
   *
   * Real providers publish an account's remaining allowance here, on ordinary
   * successful calls. Reproducing that is the only way to test the reader
   * without a provider API, which this environment cannot reach.
   */
  rateLimitHeaders?: Record<string, string>;
}

export interface MockProvider {
  baseUrl: string;
  descriptor: ProviderDescriptor;
  /** Total requests received, by path. */
  calls: { path: string; body: unknown; auth: string | null }[];
  /** Change behaviour mid-test, e.g. to bring a provider back up. */
  setBehaviour(next: MockBehaviour): void;
  close(): Promise<void>;
}

/**
 * A simulated OpenAI-compatible provider.
 *
 * Router and fallback behaviour has to be verified deterministically, and no
 * real provider will reliably produce a 429 on the sixth call or hang forever
 * on demand. Every failure mode the fallback engine claims to handle is
 * reproduced here, in-process, with no network.
 */
export async function startMockProvider(id: string, initial: MockBehaviour = {}): Promise<MockProvider> {
  let behaviour: MockBehaviour = { models: ['mock-model'], reply: 'ok', ...initial };
  const calls: MockProvider['calls'] = [];
  let successes = 0;
  let total = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const auth = (req.headers.authorization as string | undefined) ?? null;
      calls.push({ path: req.url ?? '', body, auth });
      total += 1;

      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...(behaviour.rateLimitHeaders ?? {}), ...headers });
        res.end(JSON.stringify(payload));
      };

      const respond = (): void => {
        if (behaviour.hang) return; // Deliberately never answers.

        if (behaviour.requireToken && auth !== `Bearer ${behaviour.requireToken}`) {
          send(401, { error: { message: 'invalid api key' } });
          return;
        }
        if (behaviour.alwaysStatus) {
          send(behaviour.alwaysStatus, { error: { message: `forced status ${behaviour.alwaysStatus}` } });
          return;
        }
        if (behaviour.rateLimitAfter !== undefined && successes >= behaviour.rateLimitAfter) {
          send(429, { error: { message: 'rate limit exceeded' } }, behaviour.retryAfterSec ? { 'retry-after': String(behaviour.retryAfterSec) } : {});
          return;
        }
        if (behaviour.failEvery && total % behaviour.failEvery === 0) {
          send(500, { error: { message: 'upstream exploded' } });
          return;
        }

        if (req.url?.includes('/models')) {
          send(200, { data: (behaviour.models ?? []).map((m) => ({ id: m, context_length: 32768 })) });
          return;
        }

        if (req.url?.includes('/chat/completions')) {
          successes += 1;
          const streaming = Boolean((body as { stream?: boolean } | null)?.stream);
          const usage = {
            prompt_tokens: behaviour.usage?.prompt ?? 10,
            completion_tokens: behaviour.usage?.completion ?? 5,
            total_tokens: (behaviour.usage?.prompt ?? 10) + (behaviour.usage?.completion ?? 5),
          };

          if (streaming) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(behaviour.rateLimitHeaders ?? {}) });
            const frame = (payload: unknown): void => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
            for (const word of (behaviour.reply ?? 'ok').split(' ')) {
              frame({ choices: [{ index: 0, delta: { content: `${word} ` } }] });
            }
            if (behaviour.toolCall) {
              frame({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, id: 'call_1', function: { name: behaviour.toolCall.name, arguments: JSON.stringify(behaviour.toolCall.arguments) } },
                      ],
                    },
                  },
                ],
              });
            }
            frame({ choices: [{ index: 0, delta: {}, finish_reason: behaviour.toolCall ? 'tool_calls' : 'stop' }], usage });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          send(200, {
            id: `mock-${total}`,
            model: (body as { model?: string } | null)?.model ?? 'mock-model',
            choices: [
              {
                index: 0,
                message: behaviour.toolCall
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        { id: 'call_1', type: 'function', function: { name: behaviour.toolCall.name, arguments: JSON.stringify(behaviour.toolCall.arguments) } },
                      ],
                    }
                  : { role: 'assistant', content: behaviour.reply ?? 'ok' },
                finish_reason: behaviour.toolCall ? 'tool_calls' : 'stop',
              },
            ],
            usage,
          });
          return;
        }

        if (req.url?.includes('/embeddings')) {
          successes += 1;
          const input = ((body as { input?: string[] } | null)?.input ?? ['']) as string[];
          send(200, {
            data: input.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
            usage: { prompt_tokens: 5, total_tokens: 5 },
          });
          return;
        }

        send(404, { error: { message: `no mock route for ${req.url}` } });
      };

      if (behaviour.latencyMs) setTimeout(respond, behaviour.latencyMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Unref so a mock a test forgot to close cannot hold the runner open. In-flight
  // requests still complete: they keep the loop busy on their own.
  server.unref();
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  return {
    baseUrl,
    calls,
    descriptor: {
      id,
      name: `Mock ${id}`,
      kinds: ['llm'],
      adapter: 'openai-compatible',
      baseUrl,
      auth: behaviour.requireToken ? 'api-key' : 'none',
      envKeys: [],
      trust: 'verified',
      docsUrl: null,
      local: false,
      supportsDiscovery: true,
      dataUse: {
        trainingUse: 'not_allowed',
        commercialUse: 'allowed',
        retention: 'none',
        privacyNote: 'A test double.',
        policyUrl: null,
      },
      defaultPricing: { kind: 'FREE', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null },
    },
    setBehaviour(next) {
      behaviour = { ...behaviour, ...next };
      successes = 0;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
