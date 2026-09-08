#!/usr/bin/env node
/**
 * A real MCP server, small enough to keep in the repository.
 *
 * Meridian's MCP client is genuine — it spawns a process and speaks
 * newline-delimited JSON-RPC over stdio. Proving that end to end used to need
 * `npx @modelcontextprotocol/server-everything`, which needs a network this
 * environment does not have, so the one link nobody could exercise was the one
 * that matters most: a model asking for an MCP tool and the tool actually
 * running.
 *
 * This closes that. It is not a mock of the client's expectations — it is a
 * server implementing the protocol, and the client talks to it exactly as it
 * would talk to any other. If Meridian's framing, id handling, handshake order
 * or error shape were wrong, this would fail rather than politely agree.
 *
 * Deliberately dependency-free and deterministic: no npm install, no network,
 * and the same inputs always produce the same outputs, so a test that fails
 * here has found a real defect rather than weather.
 *
 *   node scripts/local-mcp-server.mjs [--name NAME] [--fail-tool TOOL]
 *                                     [--slow-tool TOOL] [--delay-ms N]
 *
 *   --fail-tool   this tool answers with isError, as a real server does when
 *                 the underlying operation fails
 *   --slow-tool   this tool sleeps, so timeout handling can be exercised
 */
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const SERVER_NAME = flag('name', 'meridian-test-mcp');
const FAIL_TOOL = flag('fail-tool');
const SLOW_TOOL = flag('slow-tool');
const DELAY_MS = Number(flag('delay-ms', '5000'));
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Deliberately varied so tool *selection* has something to discriminate on:
 * `echo` and `add` share no vocabulary with a repository search, which is what
 * makes a relevance test meaningful rather than tautological.
 */
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo a message back to the caller verbatim.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo.' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'search_repository',
    description: 'Search repository source files for a pattern and return matching lines.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Regular expression to match.' } },
      required: ['pattern'],
    },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** MCP tool results are content blocks, not bare strings. */
const text = (s, isError = false) => ({ content: [{ type: 'text', text: String(s) }], isError });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, args) {
  if (name === FAIL_TOOL) return text(`${name} failed deliberately`, true);
  if (name === SLOW_TOOL) await sleep(DELAY_MS);

  switch (name) {
    case 'echo':
      if (typeof args?.message !== 'string') return text('echo requires a string "message"', true);
      return text(args.message);
    case 'add': {
      const { a, b } = args ?? {};
      if (typeof a !== 'number' || typeof b !== 'number') return text('add requires numbers "a" and "b"', true);
      return text(String(a + b));
    }
    case 'search_repository':
      if (typeof args?.pattern !== 'string') return text('search_repository requires a string "pattern"', true);
      // Deterministic rather than actually searching: this fixture exists to
      // prove the transport and the wiring, and a real filesystem scan would
      // make the result depend on the checkout.
      return text(`3 matches for /${args.pattern}/ in src/`);
    default:
      return text(`no such tool: ${name}`, true);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;

  // A notification has no id and takes no reply. Answering one is a protocol
  // violation that some clients treat as a fatal desync.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') return err(id, -32602, 'tools/call requires a "name"');
      return ok(id, await callTool(name, params?.arguments ?? {}));
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // No id is recoverable from unparseable input, so there is nobody to answer.
    process.stderr.write('dropped a line that was not JSON\n');
    return;
  }
  void handle(msg).catch((e) => {
    if (msg?.id != null) err(msg.id, -32603, e instanceof Error ? e.message : String(e));
  });
});

process.stderr.write(`${SERVER_NAME} ready on stdio\n`);
