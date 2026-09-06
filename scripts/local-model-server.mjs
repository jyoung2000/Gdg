#!/usr/bin/env node
/**
 * Meridian local inference server — a deterministic, dependency-free
 * OpenAI-compatible endpoint.
 *
 * WHAT THIS IS
 * ------------
 * A real HTTP server that speaks the OpenAI wire protocol correctly: model
 * listing, chat completions, server-sent-event streaming, streamed tool calls
 * with index-keyed argument fragments, embeddings, and usage accounting. Point
 * Meridian at it with MERIDIAN_LOCAL_ENDPOINTS and it is discovered, routed to,
 * streamed from and driven by the agent loop exactly like llama.cpp's
 * `llama-server`, vLLM or LM Studio would be.
 *
 * WHAT THIS IS NOT
 * ----------------
 * There is no neural network here. Responses come from a rule-based policy over
 * the conversation, so what it verifies is Meridian's own machinery — routing,
 * credential handling, streaming, tool-call assembly, the agent loop, workspace
 * mutation, fallback and cancellation — end to end over a real socket. It says
 * nothing about the quality of any model's output, and no result produced with
 * it may be reported as evidence that a *model* works.
 *
 * Two control channels exist, both deliberate:
 *
 *   1. Directives. Any user or system message may embed `[[sim: ...]]` blocks,
 *      which are executed one per assistant turn. This gives a test exact
 *      control over what the "model" does:
 *
 *        [[sim: call read_file {"path":"README.md"}]]
 *        [[sim: say Some text]]
 *        [[sim: finish Wrote the file.]]
 *        [[sim: error rate_limited]]     -> answers 429 with Retry-After
 *        [[sim: stall]]                  -> opens a stream and sends nothing
 *
 *   2. A heuristic agent policy, used when no directive is present. It reads the
 *      offered tool schemas and the previous tool output and drives a short,
 *      terminating loop: list, read, optionally write, finish. That is what lets
 *      the real agent pipeline run to completion without hand-written scripts.
 *
 * Usage:
 *   node scripts/local-model-server.mjs [--port 8080] [--latency-ms 0]
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const env = process.env[`MERIDIAN_SIM_${name.replace(/-/g, '_').toUpperCase()}`];
  return env ?? fallback;
}

const PORT = Number(flag('port', '8080'));
const HOST = flag('host', '127.0.0.1');
const LATENCY_MS = Number(flag('latency-ms', '0'));
/** Milliseconds between streamed chunks — enough to prove chunks really arrive apart. */
const CHUNK_MS = Number(flag('chunk-ms', '6'));
const EMBED_DIMS = Number(flag('embed-dims', '384'));
/**
 * Answer every chat request with this error code instead of a completion.
 *
 * A second instance started with `--fail-with rate_limited` is an inference
 * server that is up, reachable and consistently refusing — which is exactly the
 * shape a fallback chain has to survive, and not something a directive in the
 * prompt can produce, since a directive would reach every instance alike.
 */
const FAIL_WITH = flag('fail-with', '') || null;
/**
 * Append one JSON line per chat request to this file: the tools that were
 * offered, the turn, and what the policy decided.
 *
 * Written for verifying a real client. When a client gets text where a tool call
 * was expected, the question is always "what did the provider actually see" —
 * and the answer is otherwise invisible on both sides of the gateway.
 */
const LOG_REQUESTS = flag('log-requests', '') || null;

const MODELS = [
  { id: 'meridian-sim-chat', context: 32768, caps: ['chat', 'tools'] },
  { id: 'meridian-sim-coder', context: 32768, caps: ['chat', 'tools'] },
  { id: 'meridian-sim-embed', context: 8192, caps: ['embedding'] },
  // Named so model enrichment recognises it as vision-capable, the same way it
  // recognises a real multimodal model from its id.
  { id: 'meridian-sim-vision', context: 32768, caps: ['chat', 'tools', 'vision'] },
];

/* ------------------------------------------------------------------ */
/* Small utilities                                                    */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The same 4-characters-per-token approximation Meridian uses for estimates. */
const tokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ');
  return '';
}

/**
 * The request the user actually made.
 *
 * A real client wraps it: Claude Code sends the prompt at the end of a user
 * block that opens with two `<system-reminder>` sections, followed by a second
 * user message of ten kilobytes of scaffolding. Reading "the last user message"
 * gets the scaffolding; reading the first gets a reminder. Stripping the
 * client's own furniture and taking the first thing left is what a model is
 * told to do with those blocks, and it is what makes this server drivable by a
 * real client rather than only by a test.
 */
function instructionOf(messages) {
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const text = textOf(message)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * Describe the non-text parts a message carries.
 *
 * Reported back verbatim so a caller can prove its own request mapping: an
 * image that arrives as the wrong media type, truncated, or not at all is
 * invisible to a server that only ever answers with prose.
 */
function attachmentsOf(messages) {
  const seen = [];
  for (const message of messages) {
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        const url = part.image_url.url;
        const data = /^data:([^;,]+);base64,(.*)$/.exec(url);
        seen.push(
          data
            ? { kind: 'image', mediaType: data[1], bytes: Math.floor((data[2].length * 3) / 4) }
            : { kind: 'image', mediaType: 'url', bytes: url.length },
        );
      } else if (part.type === 'input_audio' && typeof part.input_audio?.data === 'string') {
        seen.push({
          kind: 'audio',
          mediaType: part.input_audio.format ?? 'unknown',
          bytes: Math.floor((part.input_audio.data.length * 3) / 4),
        });
      }
    }
  }
  return seen;
}

function promptTokens(messages) {
  return messages.reduce((sum, m) => sum + tokens(textOf(m)) + 4, 0);
}

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/**
 * In-flight and peak concurrent completions.
 *
 * Exposed at `/stats` so a caller can prove its own parallelism directly —
 * "two requests were open at the same moment" — instead of inferring it from
 * wall-clock timings, which are noisy enough to make such a test useless.
 */
const stats = { inFlight: 0, peakInFlight: 0, completions: 0, embeddings: 0 };

function enter() {
  stats.inFlight += 1;
  stats.completions += 1;
  if (stats.inFlight > stats.peakInFlight) stats.peakInFlight = stats.inFlight;
}

function leave() {
  stats.inFlight = Math.max(0, stats.inFlight - 1);
}

/* ------------------------------------------------------------------ */
/* Deterministic embeddings                                           */
/* ------------------------------------------------------------------ */

/**
 * Feature hashing over character trigrams, L2-normalised.
 *
 * Not semantic — it knows nothing about meaning — but it is a real embedding in
 * the mechanical sense: deterministic, fixed-dimension, unit length, and closer
 * for strings that share substrings. That is enough to verify the embedding
 * path (batching, dimension agreement, cosine similarity downstream) without
 * pretending to be a trained model.
 */
function embed(text, dims) {
  const vec = new Float64Array(dims);
  const s = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;
  for (let i = 0; i + 3 <= s.length; i++) {
    const gram = s.slice(i, i + 3);
    const h = createHash('sha256').update(gram).digest();
    const slot = ((h[0] << 8) | h[1]) % dims;
    // The sign comes from a different byte so collisions cancel rather than pile up.
    vec[slot] += h[2] & 1 ? 1 : -1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

/* ------------------------------------------------------------------ */
/* Directive channel                                                  */
/* ------------------------------------------------------------------ */

const DIRECTIVE = /\[\[sim:\s*([\s\S]*?)\]\]/g;

/** Collect `[[sim: ...]]` blocks from every user/system message, in order. */
function directives(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'system') continue;
    const body = textOf(m);
    for (const match of body.matchAll(DIRECTIVE)) {
      const raw = match[1].trim();
      const sep = raw.indexOf(' ');
      const verb = (sep === -1 ? raw : raw.slice(0, sep)).toLowerCase();
      const rest = sep === -1 ? '' : raw.slice(sep + 1).trim();
      out.push({ verb, rest });
    }
  }
  return out;
}

function directiveToTurn(d) {
  switch (d.verb) {
    case 'call': {
      const sep = d.rest.indexOf(' ');
      const name = sep === -1 ? d.rest : d.rest.slice(0, sep);
      const json = sep === -1 ? '{}' : d.rest.slice(sep + 1).trim();
      let args = {};
      try {
        args = JSON.parse(json);
      } catch {
        args = { _unparsed: json };
      }
      return { kind: 'tool', name, args };
    }
    case 'say':
      return { kind: 'text', text: d.rest };
    case 'finish':
      return { kind: 'tool', name: 'finish', args: { summary: d.rest || 'Done.' } };
    case 'error':
      return { kind: 'error', code: d.rest || 'server_error' };
    case 'stall':
      return { kind: 'stall' };
    default:
      return { kind: 'text', text: `Unknown directive: ${d.verb}` };
  }
}

/* ------------------------------------------------------------------ */
/* Heuristic agent policy                                             */
/* ------------------------------------------------------------------ */

const PATH_IN_BACKTICKS = /`([\w./-]+\.\w{1,8})`/;
const BARE_PATH = /\b([\w-]+(?:\/[\w-]+)*\.\w{1,8})\b/;
const FENCE = /```(?:[\w.+-]*)\n([\s\S]*?)```/;

function targetPath(instruction) {
  const backticked = instruction.match(PATH_IN_BACKTICKS);
  if (backticked) return backticked[1];
  const bare = instruction.match(BARE_PATH);
  return bare ? bare[1] : null;
}

/**
 * Pull a path out of a listing result so the next read is real.
 *
 * Absolute paths are recognised as well as relative ones: a client whose read
 * tool requires an absolute path (Claude Code's `Read`, for one) is only useful
 * to drive if the path taken from its own listing can be handed straight back.
 */
function pathFromToolOutput(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim().replace(/^[-*\d.\s|]+/, '');
    const absolute = trimmed.match(/^(\/[\w./-]+\.\w{1,8})\b/);
    if (absolute) return absolute[1];
    const relative = trimmed.match(/^([\w-]+(?:\/[\w-]+)*\.\w{1,8})\b/);
    if (relative && !relative[1].startsWith('.')) return relative[1];
  }
  return null;
}

/**
 * Decide the next turn from the offered tools and what has happened so far.
 *
 * The plan is short and always ends in `finish`, so an agent driven by this
 * server terminates rather than burning its step budget — a runaway loop would
 * prove nothing about the loop being correct.
 */
/**
 * Which offered tool plays each role, whatever the client calls it.
 *
 * Meridian names its tools `read_file`, `list_files`, `run_command`; Claude Code
 * names the same jobs `Read`, `Glob`, `Bash`; other clients differ again. Since
 * this server exists to be driven by any of them, the policy picks tools by what
 * they do rather than by an exact name — otherwise a client with a different
 * vocabulary silently gets no tool calls at all, and a test that meant to prove
 * tool round-tripping proves only that text came back.
 */
const TOOL_ROLES = {
  list: [/^list_files$/i, /^ls$/i, /^list_?directory$/i],
  glob: [/^glob$/i, /^find_?files?$/i],
  grep: [/^grep$/i, /^search$/i, /^ripgrep$/i, /^search_?files?$/i],
  read: [/^read_file$/i, /^read$/i, /^view$/i, /^cat$/i, /^open_?file$/i],
  write: [/^write_file$/i, /^write$/i, /^create_?file$/i],
  edit: [/^edit_file$/i, /^edit$/i, /^str_replace/i, /^apply_?patch$/i],
  run: [/^run_command$/i, /^bash$/i, /^shell$/i, /^execute$/i, /^terminal$/i],
  finish: [/^finish$/i, /^done$/i, /^submit$/i],
};

/** The offered tool that fills a role, or null when the client offers none. */
function toolFor(role, toolNames) {
  const patterns = TOOL_ROLES[role] ?? [];
  for (const name of toolNames) {
    if (patterns.some((p) => p.test(name))) return name;
  }
  return null;
}

/**
 * Arguments for a role, shaped for the tool that was actually offered.
 *
 * Tools differ in more than their names: Claude Code's `Read` wants an absolute
 * `file_path`, Meridian's `read_file` wants a workspace-relative `path`, and
 * `Bash` wants a `command`. Sending the wrong shape produces a validation error
 * on the client rather than a real round trip.
 */
function argsFor(role, toolName, value) {
  const claudeStyle = /^[A-Z]/.test(toolName);
  switch (role) {
    case 'list':
      return claudeStyle ? { path: value || '.' } : { path: value || '.' };
    case 'glob':
      return claudeStyle ? { pattern: value || '*' } : { pattern: value || '**/*' };
    case 'grep':
      return claudeStyle ? { pattern: value || 'export' } : { pattern: value || 'export' };
    case 'read':
      return claudeStyle ? { file_path: value } : { path: value };
    case 'write':
      return claudeStyle ? { file_path: value.path, content: value.content } : { path: value.path, content: value.content };
    case 'run':
      return { command: value };
    case 'finish':
      return { summary: value };
    default:
      return {};
  }
}

function heuristicTurn({ turn, toolNames, instruction, lastToolText, filesWritten }) {
  const has = (n) => toolNames.includes(n);
  const wantsWrite = /\b(create|add|write|implement|generate|scaffold)\b/i.test(instruction);
  const target = targetPath(instruction);

  if (!toolNames.length) {
    return { kind: 'text', text: answerText(instruction) };
  }

  const pick = (role) => toolFor(role, toolNames);
  const call = (role, value) => {
    const name = pick(role);
    return name ? { kind: 'tool', name, args: argsFor(role, name, value) } : null;
  };

  // Step 1 — orient. Whatever the client gave us that can enumerate files: a
  // list tool, a glob tool, or failing both a shell. Emitting absolute paths so
  // that a read tool requiring one can consume this output directly.
  if (turn === 0) {
    const orient =
      call('list', '.') ??
      call('glob', '*') ??
      call('run', 'find "$PWD" -maxdepth 2 -type f -not -path "*/.*" | head -20');
    if (orient) return orient;
  }

  // Step 2 — act. Writing takes precedence when the instruction asked for it.
  if (turn === 1) {
    if (wantsWrite && target && !filesWritten.includes(target)) {
      const write = call('write', { path: target, content: fileContent(instruction, target) });
      if (write) return write;
    }
    const readable = target ?? pathFromToolOutput(lastToolText ?? '');
    if (readable) {
      const read = call('read', readable);
      if (read) return read;
    }
    const search = call('grep', keyword(instruction));
    if (search) return search;
    const shell = call('run', `grep -rn ${JSON.stringify(keyword(instruction))} . | head -10`);
    if (shell) return shell;
  }

  // Step 3 — verify a write by reading it back, which also proves the workspace
  // actually persisted it.
  if (turn === 2 && filesWritten.length) {
    const verify = call('read', filesWritten[filesWritten.length - 1]);
    if (verify) return verify;
  }

  // A client with no finish tool — Claude Code, for one — ends its turn on plain
  // text, so that is the terminator when none is offered.
  return call('finish', summaryText(instruction, filesWritten)) ?? { kind: 'text', text: summaryText(instruction, filesWritten) };
}

function keyword(instruction) {
  const words = instruction.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [];
  const skip = new Set(['this', 'that', 'with', 'from', 'file', 'files', 'code', 'repository', 'please', 'should']);
  return words.find((w) => !skip.has(w)) ?? 'export';
}

function fileContent(instruction, path) {
  const fenced = instruction.match(FENCE);
  if (fenced) return fenced[1];
  const comment = path.endsWith('.md') ? '' : '// ';
  return `${comment}Generated by the Meridian local inference server.\n${comment}Instruction: ${instruction.split('\n')[0].slice(0, 200)}\n`;
}

function answerText(instruction) {
  const first = instruction.trim().split('\n')[0].slice(0, 400);
  return `meridian-sim: ${first || 'no instruction given'}`;
}

function summaryText(instruction, filesWritten) {
  const what = filesWritten.length ? `Wrote ${filesWritten.join(', ')}.` : 'Inspected the workspace without changing it.';
  return `${what} Instruction was: ${instruction.trim().split('\n')[0].slice(0, 200)}`;
}

/* ------------------------------------------------------------------ */
/* Turn planning                                                      */
/* ------------------------------------------------------------------ */

function planTurn(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const script = directives(messages);
  if (script.length) {
    return turn < script.length
      ? directiveToTurn(script[turn])
      : { kind: 'tool', name: 'finish', args: { summary: 'Script complete.' } };
  }

  const toolNames = (body.tools ?? [])
    .map((t) => t?.function?.name ?? t?.name)
    .filter((n) => typeof n === 'string');

  // `tool_choice: "none"` means the caller does not want a call, whatever the
  // policy would otherwise have chosen.
  const suppressed = body.tool_choice === 'none';

  const instruction = instructionOf(messages);

  // A request carrying an image is answered by describing what arrived, which
  // is the only answer that can prove the mapping was faithful.
  const attachments = attachmentsOf(messages);
  if (attachments.length) {
    const described = attachments.map((a) => `${a.kind} ${a.mediaType} ${a.bytes}B`).join('; ');
    return { kind: 'text', text: `meridian-sim received ${attachments.length} attachment(s): ${described}` };
  }
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

  const filesWritten = [];
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      const name = call?.function?.name;
      if (!name || !TOOL_ROLES.write.some((p) => p.test(name))) continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const path = args.path ?? args.file_path;
        if (path) filesWritten.push(path);
      } catch {
        /* a malformed call we ourselves emitted is not worth crashing over */
      }
    }
  }

  if (suppressed || !toolNames.length) return { kind: 'text', text: answerText(instruction) };
  return heuristicTurn({ turn, toolNames, instruction, lastToolText: textOf(lastTool), filesWritten });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const ERROR_STATUS = {
  rate_limited: [429, 'Rate limit exceeded'],
  unauthorized: [401, 'Invalid API key'],
  overloaded: [503, 'Model is overloaded'],
  context_length: [400, 'Context length exceeded'],
  server_error: [500, 'Internal simulator error'],
};

function sendJson(res, status, payload, headers = {}) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length, ...headers });
  res.end(buf);
}

function sendError(res, code) {
  const [status, message] = ERROR_STATUS[code] ?? ERROR_STATUS.server_error;
  const headers = status === 429 ? { 'retry-after': '2' } : {};
  sendJson(res, status, { error: { message, type: code, code } }, headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Split text into streamable pieces that keep whitespace, like a real tokenizer's output. */
function pieces(text) {
  return String(text).match(/\S+\s*|\s+/g) ?? [];
}

async function streamChat(res, body, turn) {
  const model = body.model ?? MODELS[0].id;
  const id = nextId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const frame = (choice, extra = {}) => {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [choice], ...extra })}\n\n`);
  };

  if (turn.kind === 'stall') {
    // Deliberately open the stream and never send a body frame. The client's
    // idle-timeout is the only thing that can end this.
    frame({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
    return; // The socket stays open until the client gives up or disconnects.
  }

  frame({ index: 0, delta: { role: 'assistant' }, finish_reason: null });

  let completion = 0;
  if (turn.kind === 'text') {
    for (const piece of pieces(turn.text)) {
      if (res.destroyed) return;
      frame({ index: 0, delta: { content: piece }, finish_reason: null });
      completion += tokens(piece);
      if (CHUNK_MS) await sleep(CHUNK_MS);
    }
    frame({ index: 0, delta: {}, finish_reason: 'stop' });
  } else {
    const callId = nextId('call');
    const args = JSON.stringify(turn.args ?? {});
    frame({
      index: 0,
      delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: turn.name, arguments: '' } }] },
      finish_reason: null,
    });
    // Arguments are deliberately fragmented mid-JSON: a client that parses each
    // fragment instead of accumulating them will fail here, which is the point.
    for (let i = 0; i < args.length; i += 17) {
      if (res.destroyed) return;
      frame({
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 17) } }] },
        finish_reason: null,
      });
      if (CHUNK_MS) await sleep(CHUNK_MS);
    }
    completion = tokens(args) + tokens(turn.name);
    frame({ index: 0, delta: {}, finish_reason: 'tool_calls' });
  }

  const prompt = promptTokens(body.messages ?? []);
  if (body.stream_options?.include_usage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function completionBody(body, turn) {
  const model = body.model ?? MODELS[0].id;
  const prompt = promptTokens(body.messages ?? []);
  const message = { role: 'assistant', content: null };
  let finish = 'stop';
  let completion = 0;

  if (turn.kind === 'text') {
    message.content = turn.text;
    completion = tokens(turn.text);
  } else {
    const args = JSON.stringify(turn.args ?? {});
    message.tool_calls = [{ id: nextId('call'), type: 'function', function: { name: turn.name, arguments: args } }];
    finish = 'tool_calls';
    completion = tokens(args) + tokens(turn.name);
  }

  return {
    id: nextId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      sendJson(res, 200, { status: 'ok', server: 'meridian-local-sim', models: MODELS.length });
      return;
    }

    if (req.method === 'GET' && path === '/stats') {
      sendJson(res, 200, { ...stats });
      return;
    }

    if (req.method === 'POST' && path === '/stats/reset') {
      stats.inFlight = 0;
      stats.peakInFlight = 0;
      stats.completions = 0;
      stats.embeddings = 0;
      sendJson(res, 200, { ...stats });
      return;
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'meridian-local-sim',
          context_length: m.context,
        })),
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { error: { message: `No route for ${req.method} ${path}`, type: 'not_found' } });
      return;
    }

    const body = await readBody(req);

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      if (FAIL_WITH) {
        sendError(res, FAIL_WITH);
        return;
      }
      const turn = planTurn(body);
      if (turn.kind === 'error') {
        sendError(res, turn.code);
        return;
      }
      if (LOG_REQUESTS) {
        try {
          appendFileSync(
            LOG_REQUESTS,
            `${JSON.stringify({
              model: body.model ?? null,
              messages: (body.messages ?? []).map((m) => m.role),
              tools: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean),
              instruction: instructionOf(body.messages ?? []).slice(0, 120),
              toolChoice: body.tool_choice ?? null,
              stream: body.stream === true,
              decision: turn.kind === 'tool' ? `tool:${turn.name}` : turn.kind,
            })}\n`,
          );
        } catch {
          /* logging must never break the response */
        }
      }

      enter();
      try {
        // The configured latency is counted inside the tracked window: a caller
        // measuring concurrency needs the slot held for as long as the request
        // is actually occupying the server.
        if (LATENCY_MS) await sleep(LATENCY_MS);
        if (body.stream) {
          await streamChat(res, body, turn);
        } else if (turn.kind === 'stall') {
          // A non-streaming stall never answers; the client's own timeout ends it.
        } else {
          sendJson(res, 200, completionBody(body, turn));
        }
      } finally {
        // A stall never reaches here until the socket closes, which is exactly
        // when it stops occupying a slot.
        if (turn.kind !== 'stall') leave();
        else res.on('close', leave);
      }
      return;
    }

    if (path === '/v1/embeddings' || path === '/embeddings') {
      stats.embeddings += 1;
      if (LATENCY_MS) await sleep(LATENCY_MS);
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      const dims = Number(body.dimensions) > 0 ? Number(body.dimensions) : EMBED_DIMS;
      sendJson(res, 200, {
        object: 'list',
        model: body.model ?? 'meridian-sim-embed',
        data: input.map((text, index) => ({ object: 'embedding', index, embedding: embed(text, dims) })),
        usage: { prompt_tokens: input.reduce((s, t) => s + tokens(t), 0), total_tokens: input.reduce((s, t) => s + tokens(t), 0) },
      });
      return;
    }

    sendJson(res, 404, { error: { message: `No route for POST ${path}`, type: 'not_found' } });
  } catch (e) {
    sendJson(res, 400, { error: { message: e instanceof Error ? e.message : String(e), type: 'invalid_request_error' } });
  }
});

// A stalled stream must not be reaped by the server before the client's own
// idle timeout fires, or the test would be measuring Node's timeout instead.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  const addr = server.address();
  process.stdout.write(
    `meridian-local-sim listening on http://${HOST}:${addr.port}/v1 (models: ${MODELS.map((m) => m.id).join(', ')})` +
      `${FAIL_WITH ? ` [failing every chat with ${FAIL_WITH}]` : ''}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
