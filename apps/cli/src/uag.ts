#!/usr/bin/env node
/**
 * `uag` — the Meridian command line.
 *
 * The CLI is a thin, honest client of the same HTTP API the web app uses. It
 * has no privileged path into the gateway: anything it can do, a script can do,
 * which is the point of shipping a documented API rather than a private one.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_PORT, formatCost, formatDuration } from '@meridian/shared';

interface Config {
  baseUrl: string;
  apiKey: string | null;
  workspaceId: string | null;
  mode: string | null;
}

const CONFIG_PATH = join(homedir(), '.config', 'meridian', 'cli.json');

function loadConfig(): Config {
  const fromEnv: Partial<Config> = {
    baseUrl: process.env.MERIDIAN_URL ?? undefined,
    apiKey: process.env.MERIDIAN_API_KEY ?? undefined,
  };
  let stored: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
    } catch {
      // A corrupt config should not stop the CLI from working with defaults.
    }
  }
  return {
    baseUrl: fromEnv.baseUrl ?? stored.baseUrl ?? `http://localhost:${DEFAULT_PORT}`,
    apiKey: fromEnv.apiKey ?? stored.apiKey ?? null,
    workspaceId: stored.workspaceId ?? null,
    mode: stored.mode ?? null,
  };
}

function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColour ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColour ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColour ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColour ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColour ? `\x1b[36m${s}\x1b[0m` : s),
};

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const err = (s: string): void => {
  process.stderr.write(`${c.red('error')} ${s}\n`);
};

/** Fixed-width table. Columns size to their widest cell. */
function table(headers: string[], rows: string[][]): void {
  if (!rows.length) {
    out(c.dim('  (nothing to show)'));
    return;
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  out(`  ${headers.map((h, i) => c.dim(h.padEnd(widths[i]))).join('  ')}`);
  for (const row of rows) {
    out(`  ${row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

class Client {
  constructor(private readonly config: Config) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...extra,
    };
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      throw new Error(
        `Cannot reach Meridian at ${this.config.baseUrl}. Is it running? (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const text = await res.text();
    const parsed: unknown = text ? safeParse(text) : null;
    if (!res.ok) {
      const message = (parsed as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return parsed as T;
  }

  /** Stream a chat completion, printing tokens as they arrive. */
  async stream(
    body: Record<string, unknown>,
    onMeta: (meta: Record<string, unknown>) => void,
    onDelta?: (delta: string) => void,
  ): Promise<void> {
    const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers({ accept: 'text/event-stream' }),
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        const evt = safeParse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: Record<string, number>;
          meridian?: Record<string, unknown>;
        } | null;
        if (evt?.meridian) onMeta(evt.meridian);
        if (evt?.usage) onMeta({ usage: evt.usage });
        const delta = evt?.choices?.[0]?.delta?.content;
        if (delta) {
          if (onDelta) onDelta(delta);
          else process.stdout.write(delta);
        }
      }
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                   */
/* ------------------------------------------------------------------ */

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
/** The routing-mode flag, uppercased so `--mode fast` means FAST rather than silently AUTO. */
const modeFlag = (flags: Record<string, string | boolean | undefined>): string | undefined => {
  const raw = str(flags.mode);
  return raw ? raw.toUpperCase() : undefined;
};

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

const HELP = `${c.bold('uag')} — Meridian Universal AI Gateway

${c.dim('USAGE')}
  uag <command> [options]

${c.dim('COMMANDS')}
  chat [prompt]          Chat with an automatically routed model
  code <request>         Run a coding agent against a workspace
  task <request>         Alias for code, with the full agent pipeline
  image <prompt>         Generate an image
  video <prompt>         Generate a video
  audio <text>           Synthesise speech
  research <question>    Research a question against a workspace
  models [query]         List models the gateway can route to
  providers              List providers and their health
  pools                  List inference pools and reservations
  benchmark <model>      Run the benchmark suite against a model
  compare <prompt>       Run one prompt across several models
  usage [--days N]       Show usage, cost and fallback statistics
  status                 Show gateway status
  configure              Set the gateway URL and API key
  help                   Show this help

${c.dim('COMMON OPTIONS')}
  --model <id>           Pin a model, e.g. groq:llama-3.3-70b-versatile
  --provider <id>        Pin a provider
  --pool <id>            Route through an inference pool
  --mode <MODE>          AUTO | BEST | FAST | CHEAP | FREE | LOCAL
  --free                 Only models that cannot charge money
  --local                Only models on your own hardware
  --paid                 Permit paid routing for this request
  --budget <usd>         Hard cost ceiling for this request
  --workspace <id>       Workspace to act in
  --json                 Machine-readable output
  --url <url>            Gateway URL (default http://localhost:${DEFAULT_PORT})

${c.dim('EXAMPLES')}
  uag chat "explain this error" --mode FAST
  uag code "add retry logic to the http client" --workspace ws_123
  uag image "a calm desk at dawn" --free
  uag models --free
  uag usage --days 7
`;

function routingFlags(flags: Args['flags']): Record<string, unknown> {
  const meridian: Record<string, unknown> = {};
  if (modeFlag(flags)) meridian.mode = modeFlag(flags);
  if (str(flags.pool)) meridian.pool = str(flags.pool);
  if (str(flags.provider)) meridian.provider = str(flags.provider);
  if (flags.free) meridian.free_only = true;
  if (flags.local) meridian.local_only = true;
  if (flags.paid) meridian.allow_paid = true;
  if (str(flags.budget)) meridian.budget = Number(str(flags.budget));
  if (str(flags.workspace)) meridian.workspace_id = str(flags.workspace);
  return meridian;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? 'help';

  if (command === 'help' || flags.help || flags.h) {
    out(HELP);
    return 0;
  }

  const config = loadConfig();
  if (str(flags.url)) config.baseUrl = str(flags.url)!;
  const client = new Client(config);
  const json = Boolean(flags.json);

  switch (command) {
    /* ---------------- configure ---------------- */
    case 'configure': {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const url = (await rl.question(`Gateway URL [${config.baseUrl}]: `)).trim() || config.baseUrl;
      const key = (await rl.question(`API key (leave blank for none) [${config.apiKey ? 'unchanged' : 'none'}]: `)).trim();
      rl.close();
      const next: Config = { ...config, baseUrl: url, apiKey: key || config.apiKey };
      saveConfig(next);
      out(`${c.green('✓')} Saved to ${CONFIG_PATH}`);
      return 0;
    }

    /* ---------------- status ---------------- */
    case 'status': {
      const info = await client.request<{
        name: string;
        version: string;
        port: number;
        counts: Record<string, number>;
        sandbox: { kind: string; degradedReason: string | null };
        warnings: { level: string; message: string }[];
        allowPaid: boolean;
      }>('/api/system/info');
      if (json) {
        out(JSON.stringify(info, null, 2));
        return 0;
      }
      out();
      out(`  ${c.bold(info.name)} ${c.dim(`v${info.version}`)}  ${c.dim(config.baseUrl)}`);
      out();
      table(
        ['', ''],
        [
          ['Providers', `${info.counts.providersConfigured} configured of ${info.counts.providers} (${info.counts.providersVerified} verified)`],
          ['Models', String(info.counts.models)],
          ['Pools', String(info.counts.pools)],
          ['Workspaces', String(info.counts.workspaces)],
          ['Sandbox', info.sandbox.kind],
          ['Paid routing', info.allowPaid ? 'enabled' : c.dim('disabled')],
        ],
      );
      for (const w of info.warnings) {
        out();
        out(`  ${w.level === 'warn' ? c.yellow('!') : c.cyan('i')} ${w.message}`);
      }
      out();
      return 0;
    }

    /* ---------------- models ---------------- */
    case 'models': {
      const query = new URLSearchParams();
      if (positional[1]) query.set('search', positional[1]);
      if (flags.free) query.set('free', 'true');
      if (str(flags.provider)) query.set('provider', str(flags.provider)!);
      const res = await client.request<{ models: Record<string, unknown>[]; total: number }>(`/api/models?${query}`);
      if (json) {
        out(JSON.stringify(res.models, null, 2));
        return 0;
      }
      out();
      table(
        ['MODEL', 'PROVIDER', 'CONTEXT', 'PRICING', 'LATENCY', 'STATUS'],
        res.models.slice(0, 60).map((m) => {
          const pricing = m.pricing as { kind: string };
          const perf = m.performance as { latencyMs: number | null } | null;
          return [
            String(m.providerModelId),
            String(m.providerId),
            m.contextLength ? formatContext(Number(m.contextLength)) : c.dim('—'),
            m.free ? c.green(pricing.kind) : pricing.kind,
            perf?.latencyMs ? `${(perf.latencyMs / 1000).toFixed(1)}s` : c.dim('—'),
            String(m.status),
          ];
        }),
      );
      out();
      out(c.dim(`  ${res.total} model${res.total === 1 ? '' : 's'}${res.total > 60 ? ', showing 60' : ''}`));
      out();
      return 0;
    }

    /* ---------------- providers ---------------- */
    case 'providers': {
      const res = await client.request<{ providers: Record<string, unknown>[] }>('/api/providers');
      if (json) {
        out(JSON.stringify(res.providers, null, 2));
        return 0;
      }
      out();
      table(
        ['PROVIDER', 'SUPPORT', 'TRUST', 'MODELS', 'FREE', 'HEALTH', 'ERROR RATE'],
        res.providers.map((p) => {
          const health = p.health as { state: string; errorRate: number };
          const state = String(p.supportState);
          return [
            String(p.name),
            state === 'supported' ? c.green(state) : state === 'not_configured' ? c.dim(state) : c.yellow(state),
            String(p.trust),
            String(p.models),
            String(p.freeModels),
            health.state,
            `${Math.round(health.errorRate * 100)}%`,
          ];
        }),
      );
      out();
      return 0;
    }

    /* ---------------- pools ---------------- */
    case 'pools': {
      const res = await client.request<{ pools: Record<string, unknown>[]; reservations: Record<string, unknown>[] }>('/api/pools');
      if (json) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      out();
      table(
        ['POOL', 'STRATEGY', 'MEMBERS', 'CONCURRENCY', 'DAILY BUDGET', 'SPENT TODAY'],
        res.pools.map((p) => {
          const usage = p.usage as { spentToday: number };
          return [
            String(p.name),
            String(p.strategy),
            String((p.members as unknown[]).length || 'any'),
            p.concurrencyLimit ? String(p.concurrencyLimit) : c.dim('unlimited'),
            p.budgetLimit === null ? c.dim('unlimited') : formatCost(Number(p.budgetLimit)),
            formatCost(usage.spentToday),
          ];
        }),
      );
      if (res.reservations.length) {
        out();
        out(c.dim('  RESERVATIONS'));
        table(
          ['LABEL', 'POOL', 'STATUS', 'CONCURRENCY', 'SPEND'],
          res.reservations.map((r) => [String(r.label), String(r.poolId), String(r.status), String(r.maxConcurrency), formatCost(Number(r.spend))]),
        );
      }
      out();
      return 0;
    }

    /* ---------------- usage ---------------- */
    case 'usage': {
      const days = Number(str(flags.days) ?? 30);
      const res = await client.request<{ summary: { totals: Record<string, number>; byModel: Record<string, unknown>[] } }>(`/api/usage?days=${days}`);
      if (json) {
        out(JSON.stringify(res.summary, null, 2));
        return 0;
      }
      const t = res.summary.totals;
      out();
      out(`  ${c.bold(`Last ${days} days`)}`);
      out();
      table(
        ['', ''],
        [
          ['Requests', String(t.requests)],
          ['Tokens', t.tokens.toLocaleString()],
          ['Cost', formatCost(t.cost)],
          ['Failures', String(t.failures)],
          ['Fallbacks', String(t.fallbacks)],
        ],
      );
      if (res.summary.byModel.length) {
        out();
        out(c.dim('  BY MODEL'));
        table(
          ['MODEL', 'REQUESTS', 'TOKENS', 'COST', 'AVG LATENCY', 'SUCCESS'],
          res.summary.byModel.slice(0, 20).map((m) => [
            String(m.modelId),
            String(m.requests),
            Number(m.tokens).toLocaleString(),
            formatCost(Number(m.cost)),
            `${(Number(m.avgLatency) / 1000).toFixed(1)}s`,
            `${Math.round(Number(m.successRate) * 100)}%`,
          ]),
        );
      }
      out();
      return 0;
    }

    /* ---------------- chat ---------------- */
    case 'chat': {
      const prompt = positional.slice(1).join(' ') || (await readStdin());
      if (!prompt) {
        err('Give a prompt: uag chat "your question"');
        return 1;
      }
      let meta: Record<string, unknown> = {};
      // --json wants one parseable object, so the stream is collected rather
      // than teed to the terminal as it arrives.
      const collected: string[] = [];
      await client.stream(
        {
          model: str(flags.model) ?? 'auto',
          messages: [{ role: 'user', content: prompt }],
          meridian: routingFlags(flags),
        },
        (m) => {
          meta = { ...meta, ...m };
        },
        json ? (delta) => collected.push(delta) : undefined,
      );
      if (json) {
        out(JSON.stringify({ content: collected.join(''), ...meta }, null, 2));
        return 0;
      }
      out();
      const routing = meta.routing as { summary?: string } | undefined;
      const usage = meta.usage as { total_tokens?: number } | undefined;
      out(
        c.dim(
          `  ${String(meta.provider ?? '')} ${String(meta.model ?? '')}` +
            (usage?.total_tokens ? ` · ${usage.total_tokens} tokens` : '') +
            (typeof meta.cost === 'number' ? ` · ${formatCost(meta.cost)}` : ''),
        ),
      );
      if (flags.why && routing?.summary) out(c.dim(`  ${routing.summary}`));
      return 0;
    }

    /* ---------------- code / task ---------------- */
    case 'code':
    case 'task': {
      const request = positional.slice(1).join(' ') || (await readStdin());
      const workspaceId = str(flags.workspace) ?? config.workspaceId;
      if (!request) {
        err('Describe what you want: uag code "add retry logic to the http client"');
        return 1;
      }
      if (!workspaceId) {
        err('No workspace. Pass --workspace <id>, or create one in the app.');
        return 1;
      }

      const { estimate, pipeline } = await client.request<{
        estimate: { calls: number; models: number; cost: number; seconds: number; freeAvailable: boolean; strategy: string };
        pipeline: { steps: string[]; rationale: string };
      }>('/api/tasks/estimate', { method: 'POST', body: { workspaceId, request, mode: modeFlag(flags), allowPaid: Boolean(flags.paid) } });

      out();
      out(`  ${c.bold('Plan')}  ${pipeline.steps.join(' → ')}`);
      out(`  ${c.dim(pipeline.rationale)}`);
      out();
      out(
        `  Estimated ${c.bold(formatCost(estimate.cost))} · ${estimate.calls} calls · ${estimate.models} models · ~${formatDuration(estimate.seconds * 1000)}` +
          (estimate.freeAvailable ? c.green('  (free capacity available)') : ''),
      );
      out();

      if (estimate.cost > 0 && !flags.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`  This will cost about ${formatCost(estimate.cost)}. Continue? [y/N] `)).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') {
          out('  Cancelled.');
          return 0;
        }
      }

      const { task } = await client.request<{ task: { id: string; title: string } }>('/api/tasks', {
        method: 'POST',
        body: { workspaceId, request, mode: modeFlag(flags), allowPaid: Boolean(flags.paid), budget: str(flags.budget) ? Number(str(flags.budget)) : undefined },
      });
      out(`  ${c.cyan('▸')} ${task.title}  ${c.dim(task.id)}`);
      out();

      return followTask(client, task.id, json);
    }

    /* ---------------- research ---------------- */
    case 'research': {
      const question = positional.slice(1).join(' ') || (await readStdin());
      const workspaceId = str(flags.workspace) ?? config.workspaceId;
      if (!question || !workspaceId) {
        err('Usage: uag research "your question" --workspace <id>');
        return 1;
      }
      const { task } = await client.request<{ task: { id: string } }>('/api/tasks', {
        method: 'POST',
        body: { workspaceId, request: question, mode: modeFlag(flags), pipeline: 'research' },
      });
      return followTask(client, task.id, json);
    }

    /* ---------------- media ---------------- */
    case 'image':
    case 'video':
    case 'audio': {
      const prompt = positional.slice(1).join(' ') || (await readStdin());
      if (!prompt) {
        err(`Give a prompt: uag ${command} "your prompt"`);
        return 1;
      }
      const endpoint = command === 'audio' ? 'speech' : command;
      const body =
        command === 'audio'
          ? { text: prompt, model: str(flags.model), allowPaid: Boolean(flags.paid) }
          : {
              prompt,
              model: str(flags.model),
              provider: str(flags.provider),
              pool: str(flags.pool),
              mode: modeFlag(flags),
              aspectRatio: str(flags.aspect),
              seed: str(flags.seed) ? Number(str(flags.seed)) : undefined,
              allowPaid: Boolean(flags.paid),
            };

      const { job } = await client.request<{ job: { id: string } }>(`/api/generations/${endpoint}`, { method: 'POST', body });
      out(`  ${c.dim('generating…')}`);

      const finished = await pollJob(client, job.id);
      if (json) {
        out(JSON.stringify(finished, null, 2));
        return finished.status === 'completed' ? 0 : 1;
      }
      if (finished.status !== 'completed') {
        err(finished.error ?? 'Generation failed');
        return 1;
      }
      out();
      for (const asset of finished.assets) {
        const url = asset.url.startsWith('/') ? `${config.baseUrl}${asset.url}` : asset.url;
        out(`  ${c.green('✓')} ${url}`);
        if (str(flags.output)) {
          const target = resolve(str(flags.output)!);
          const res = await fetch(url);
          writeFileSync(target, Buffer.from(await res.arrayBuffer()));
          out(`  ${c.dim('saved to')} ${target}`);
        }
      }
      out(c.dim(`  ${finished.providerId ?? ''} ${finished.modelId ?? ''} · ${formatCost(finished.cost)}`));
      out();
      return 0;
    }

    /* ---------------- benchmark ---------------- */
    case 'benchmark': {
      const modelId = positional[1];
      if (!modelId) {
        err('Usage: uag benchmark <provider:model>');
        return 1;
      }
      out(`  ${c.dim('running the benchmark suite…')}`);
      const res = await client.request<{ summary: Record<string, number | null> | null }>('/api/models/benchmark', {
        method: 'POST',
        body: { modelId },
      });
      if (json || !res.summary) {
        out(JSON.stringify(res, null, 2));
        return 0;
      }
      const s = res.summary;
      out();
      table(
        ['', ''],
        [
          ['Coding', score(s.coding)],
          ['Reasoning', score(s.reasoning)],
          ['General', score(s.general)],
          ['Tool use', score(s.toolUse)],
          ['Latency', s.latencyMs ? `${(Number(s.latencyMs) / 1000).toFixed(2)}s` : '—'],
          ['p95 latency', s.p95LatencyMs ? `${(Number(s.p95LatencyMs) / 1000).toFixed(2)}s` : '—'],
          ['Jitter', s.jitterMs ? `${Math.round(Number(s.jitterMs))}ms` : '—'],
          ['Tokens/sec', s.tokensPerSecond ? Number(s.tokensPerSecond).toFixed(1) : '—'],
          ['Uptime', s.uptime != null ? `${Math.round(Number(s.uptime) * 100)}%` : '—'],
        ],
      );
      out();
      return 0;
    }

    /* ---------------- compare ---------------- */
    case 'compare': {
      const prompt = positional.slice(1).join(' ') || (await readStdin());
      const models = (str(flags.models) ?? '').split(',').map((m) => m.trim()).filter(Boolean);
      if (!prompt || !models.length) {
        err('Usage: uag compare "prompt" --models a:1,b:2');
        return 1;
      }
      const res = await client.request<{ results: Record<string, unknown>[] }>('/api/models/compare', {
        method: 'POST',
        body: { prompt, models },
      });
      if (json) {
        out(JSON.stringify(res.results, null, 2));
        return 0;
      }
      for (const r of res.results) {
        out();
        out(`  ${c.bold(String(r.modelId))}  ${c.dim(`${Number(r.latencyMs) / 1000}s · ${formatCost(Number(r.cost))}`)}`);
        out(r.error ? `  ${c.red(String(r.error))}` : indent(String(r.output ?? ''), 2));
      }
      out();
      return 0;
    }

    default:
      err(`Unknown command "${command}". Run "uag help".`);
      return 1;
  }
}

/* ------------------------------------------------------------------ */

function score(v: number | null | undefined): string {
  if (v == null) return c.dim('not measured');
  const filled = Math.round((v / 100) * 5);
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}  ${v}`;
}

function indent(text: string, spaces: number): string {
  return text.split('\n').map((l) => `${' '.repeat(spaces)}${l}`).join('\n');
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

interface JobShape {
  status: string;
  error: string | null;
  assets: { url: string }[];
  cost: number;
  modelId: string | null;
  providerId: string | null;
  progress: number;
}

/** Poll a generation job to completion, with a bounded wait. */
async function pollJob(client: Client, jobId: string, timeoutMs = 900_000): Promise<JobShape> {
  const deadline = Date.now() + timeoutMs;
  let interval = 1000;
  while (Date.now() < deadline) {
    const { job } = await client.request<{ job: JobShape }>(`/api/generations/${jobId}`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, interval));
    // Back off so a long video generation is not a thousand polls.
    interval = Math.min(interval * 1.4, 5000);
  }
  throw new Error('Timed out waiting for the generation to finish');
}

/** Follow a task's timeline until it finishes, printing each step. */
async function followTask(client: Client, taskId: string, json: boolean): Promise<number> {
  const seen = new Map<string, string>();
  const deadline = Date.now() + 3_600_000;

  while (Date.now() < deadline) {
    const res = await client.request<{
      task: { status: string; error: string | null; result: string | null; usage: { cost: number; totalTokens: number } };
      steps: { id: string; label: string; status: string; summary: string | null; modelId: string | null; latencyMs: number | null }[];
      running: boolean;
    }>(`/api/tasks/${taskId}`);

    for (const step of res.steps) {
      if (seen.get(step.id) === step.status) continue;
      seen.set(step.id, step.status);
      const glyph =
        step.status === 'completed' ? c.green('✓') : step.status === 'failed' ? c.red('✗') : step.status === 'running' ? c.cyan('●') : c.dim('○');
      const detail = step.modelId ? c.dim(`  ${step.modelId}${step.latencyMs ? ` · ${formatDuration(step.latencyMs)}` : ''}`) : '';
      out(`  ${glyph} ${step.label}${detail}`);
      if (step.status === 'failed' && step.summary) out(`    ${c.red(step.summary)}`);
    }

    if (!res.running && res.task.status !== 'queued' && res.task.status !== 'running') {
      if (json) {
        out(JSON.stringify(res, null, 2));
        return res.task.status === 'completed' ? 0 : 1;
      }
      out();
      if (res.task.result) out(indent(res.task.result, 2));
      out();
      out(c.dim(`  ${res.task.usage.totalTokens} tokens · ${formatCost(res.task.usage.cost)}`));
      if (res.task.error) {
        out(`  ${c.red(res.task.error)}`);
        return 1;
      }
      out(c.dim('  Review the diff in the app before accepting.'));
      out();
      return 0;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  err('Timed out following the task');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
