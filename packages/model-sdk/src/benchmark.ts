import type { CompletionRequest, CompletionResponse, ModelDescriptor } from '@meridian/shared';
import { percentile } from './scoring.js';

/**
 * A benchmark case with an objectively checkable answer.
 *
 * The suite is small and deterministic on purpose: its job is to rank models
 * relative to each other cheaply and repeatably, not to reproduce a public
 * leaderboard. Every case is verified by a pure function, so no second model is
 * needed to grade the first.
 */
export interface BenchmarkCase {
  id: string;
  dimension: 'coding' | 'reasoning' | 'general' | 'toolUse';
  prompt: string;
  system?: string;
  maxTokens: number;
  /** Returns [0,1]. Partial credit is allowed. */
  check: (output: string) => number;
  /** Tools the case requires; presence forces a tool-capable model. */
  tools?: CompletionRequest['tools'];
}

const contains = (needles: string[], out: string): number => {
  const lower = out.toLowerCase();
  const hits = needles.filter((n) => lower.includes(n.toLowerCase())).length;
  return hits / needles.length;
};

/** Pull the body of the first fenced code block, or the whole output. */
export function extractCode(output: string): string {
  const m = /```(?:[a-z]*\n)?([\s\S]*?)```/i.exec(output);
  return (m ? m[1] : output).trim();
}

export const BENCHMARK_SUITE: BenchmarkCase[] = [
  {
    id: 'code-reverse-words',
    dimension: 'coding',
    system: 'You are a precise programmer. Reply with a single fenced code block and nothing else.',
    prompt:
      'Write a JavaScript function `reverseWords(s)` that reverses the order of words in a string, ' +
      'collapsing runs of whitespace to a single space and trimming the ends. Return only the code.',
    maxTokens: 400,
    check: (out) => {
      const code = extractCode(out);
      if (!/function\s+reverseWords|const\s+reverseWords\s*=/.test(code)) return 0;
      // Run it: correctness here is executable, not judged.
      try {
        const fn = new Function(`${code}; return reverseWords;`)() as (s: string) => string;
        const cases: [string, string][] = [
          ['the sky  is blue', 'blue is sky the'],
          ['  hello world  ', 'world hello'],
          ['a', 'a'],
        ];
        const passed = cases.filter(([input, want]) => {
          try {
            return fn(input) === want;
          } catch {
            return false;
          }
        }).length;
        return passed / cases.length;
      } catch {
        return 0.1; // Parsed as code but did not run.
      }
    },
  },
  {
    id: 'code-fix-bug',
    dimension: 'coding',
    system: 'You are a precise programmer. Reply with a single fenced code block and nothing else.',
    prompt:
      'This function is meant to return the second largest DISTINCT number in an array, or null if ' +
      'there is none. Fix it and return only the corrected code:\n\n' +
      '```js\nfunction secondLargest(a) {\n  a.sort();\n  return a[a.length - 2];\n}\n```',
    maxTokens: 400,
    check: (out) => {
      const code = extractCode(out);
      try {
        const fn = new Function(`${code}; return secondLargest;`)() as (a: number[]) => number | null;
        const cases: [number[], number | null][] = [
          [[1, 2, 3, 10], 3],
          [[5, 5, 5], null],
          [[10, 9], 9],
          [[2], null],
        ];
        const passed = cases.filter(([input, want]) => {
          try {
            return fn([...input]) === want;
          } catch {
            return false;
          }
        }).length;
        return passed / cases.length;
      } catch {
        return 0;
      }
    },
  },
  {
    id: 'reason-scheduling',
    dimension: 'reasoning',
    system: 'Answer with only the final answer on the last line, prefixed by "ANSWER: ".',
    prompt:
      'Three servers finish a job in 6, 10 and 15 minutes respectively when each works alone. ' +
      'Running all three in parallel on independent shards of equal size, the job finishes when the ' +
      'slowest shard finishes. If instead you split the work in proportion to each server\'s speed so ' +
      'they all finish simultaneously, how many minutes does the job take? Give the exact value.',
    maxTokens: 700,
    // Combined rate 1/6+1/10+1/15 = 1/3, so 3 minutes.
    check: (out) => {
      const tail = out.slice(-200);
      return /answer:\s*3\b/i.test(tail) || /\b3\s*minutes\b/i.test(tail) ? 1 : 0;
    },
  },
  {
    id: 'reason-constraint',
    dimension: 'reasoning',
    system: 'Answer with only the final answer on the last line, prefixed by "ANSWER: ".',
    prompt:
      'A deploy pipeline has stages A, B, C, D. B must run after A. C must run after B. D can run any ' +
      'time after A but must not run immediately after C. How many valid orderings of all four stages are there?',
    maxTokens: 700,
    // Orders with A<B<C: ABCD, ABDC, ADBC. ABCD has D immediately after C -> invalid. So 2.
    check: (out) => (/answer:\s*2\b/i.test(out.slice(-200)) ? 1 : 0),
  },
  {
    id: 'general-extract',
    dimension: 'general',
    system: 'Reply with only a JSON object. No prose, no code fence.',
    prompt:
      'Extract the fields name, port and protocol from this log line as JSON:\n' +
      '"service=auth-gateway listening on 8443 over https (pid 4821)"',
    maxTokens: 200,
    check: (out) => {
      try {
        const obj = JSON.parse(out.trim().replace(/^```(?:json)?|```$/g, '').trim()) as Record<string, unknown>;
        let score = 0;
        if (String(obj.name ?? '') === 'auth-gateway') score += 0.4;
        if (Number(obj.port ?? 0) === 8443) score += 0.3;
        if (String(obj.protocol ?? '').toLowerCase() === 'https') score += 0.3;
        return score;
      } catch {
        return 0;
      }
    },
  },
  {
    id: 'general-instruction',
    dimension: 'general',
    prompt:
      'List exactly three benefits of connection pooling. Reply with three lines, each starting with "- ", ' +
      'and nothing else.',
    maxTokens: 250,
    check: (out) => {
      const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const bullets = lines.filter((l) => l.startsWith('- '));
      const exact = lines.length === 3 && bullets.length === 3 ? 1 : bullets.length === 3 ? 0.7 : 0.3;
      return exact * (contains(['connection'], out) ? 1 : 0.6);
    },
  },
  {
    id: 'tool-call',
    dimension: 'toolUse',
    prompt: 'What is the weather in Reykjavik right now? Use the tool.',
    maxTokens: 300,
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' }, units: { type: 'string', enum: ['c', 'f'] } },
          required: ['city'],
        },
      },
    ],
    // Scored from the tool call itself, not the text; see runBenchmark.
    check: () => 0,
  },
];

export interface BenchmarkResult {
  modelId: string;
  caseId: string;
  dimension: BenchmarkCase['dimension'];
  score: number;
  latencyMs: number;
  ttftMs: number | null;
  outputTokens: number;
  tokensPerSecond: number | null;
  error: string | null;
  at: number;
}

export interface BenchmarkSummary {
  modelId: string;
  coding: number | null;
  reasoning: number | null;
  general: number | null;
  toolUse: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  p95LatencyMs: number | null;
  jitterMs: number | null;
  tokensPerSecond: number | null;
  uptime: number;
  cases: number;
  errors: number;
}

export type BenchmarkRunner = (req: CompletionRequest) => Promise<CompletionResponse>;

/** Run the suite against one model. Cases the model cannot serve are skipped. */
export async function runBenchmark(
  model: ModelDescriptor,
  run: BenchmarkRunner,
  opts: { cases?: BenchmarkCase[]; signal?: AbortSignal; now?: () => number } = {},
): Promise<BenchmarkResult[]> {
  const now = opts.now ?? (() => Date.now());
  const supportsTools = model.capabilities.includes('tools');
  const cases = (opts.cases ?? BENCHMARK_SUITE).filter((c) => !c.tools || supportsTools);
  const results: BenchmarkResult[] = [];

  for (const c of cases) {
    if (opts.signal?.aborted) break;
    const started = now();
    try {
      const res = await run({
        model: model.providerModelId,
        messages: [
          ...(c.system ? [{ role: 'system' as const, content: c.system }] : []),
          { role: 'user' as const, content: c.prompt },
        ],
        maxTokens: c.maxTokens,
        temperature: 0,
        tools: c.tools,
        signal: opts.signal,
      });
      const latencyMs = res.latencyMs || now() - started;
      const outputTokens = res.usage.completionTokens;
      // The tool case is scored on whether a well-formed call was actually made.
      const score =
        c.dimension === 'toolUse'
          ? scoreToolCase(res)
          : c.check(res.content);
      results.push({
        modelId: model.id,
        caseId: c.id,
        dimension: c.dimension,
        score,
        latencyMs,
        ttftMs: res.ttftMs,
        outputTokens,
        tokensPerSecond: outputTokens > 0 && latencyMs > 0 ? (outputTokens / latencyMs) * 1000 : null,
        error: null,
        at: now(),
      });
    } catch (e) {
      results.push({
        modelId: model.id,
        caseId: c.id,
        dimension: c.dimension,
        score: 0,
        latencyMs: now() - started,
        ttftMs: null,
        outputTokens: 0,
        tokensPerSecond: null,
        error: e instanceof Error ? e.message : String(e),
        at: now(),
      });
    }
  }
  return results;
}

function scoreToolCase(res: CompletionResponse): number {
  const call = res.toolCalls.find((t) => t.name === 'get_weather');
  if (!call) return 0;
  const city = String(call.arguments.city ?? '').toLowerCase();
  if (!city) return 0.4;
  return city.includes('reykjav') ? 1 : 0.6;
}

export function summarise(results: BenchmarkResult[]): BenchmarkSummary | null {
  if (!results.length) return null;
  const ok = results.filter((r) => r.error === null);
  const dim = (d: BenchmarkCase['dimension']): number | null => {
    const rows = ok.filter((r) => r.dimension === d);
    if (!rows.length) return null;
    return Math.round((rows.reduce((s, r) => s + r.score, 0) / rows.length) * 100);
  };
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const mean = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : null;
  const variance = mean != null ? latencies.reduce((s, v) => s + (v - mean) ** 2, 0) / latencies.length : null;
  const ttfts = ok.map((r) => r.ttftMs).filter((v): v is number => v != null);
  const tps = ok.map((r) => r.tokensPerSecond).filter((v): v is number => v != null);

  return {
    modelId: results[0].modelId,
    coding: dim('coding'),
    reasoning: dim('reasoning'),
    general: dim('general'),
    toolUse: dim('toolUse'),
    latencyMs: mean,
    ttftMs: ttfts.length ? ttfts.reduce((s, v) => s + v, 0) / ttfts.length : null,
    // A suite of seven cases cannot yield a 95th percentile: nearest-rank
    // would return the slowest run wearing a percentile's name. percentile()
    // returns null below the sample size where the answer means what it says.
    p95LatencyMs: percentile(latencies, 0.95),
    // Deliberately null. The spread across these cases is spread across
    // DIFFERENT PROMPTS — the suite varies maxTokens from 200 to 700 — so its
    // standard deviation measures prompt length, not serving jitter. Serving
    // jitter comes from repeated live calls, in applyPerformance.
    jitterMs: null,
    tokensPerSecond: tps.length ? tps.reduce((s, v) => s + v, 0) / tps.length : null,
    uptime: results.length ? ok.length / results.length : 0,
    cases: results.length,
    errors: results.length - ok.length,
  };
}
