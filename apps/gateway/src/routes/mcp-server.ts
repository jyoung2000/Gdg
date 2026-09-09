import type { FastifyInstance } from 'fastify';
import { MERIDIAN_VERSION } from '@meridian/shared';
import type { App } from '../services/app.js';
import { requireScope } from './authz.js';

/**
 * Meridian AS an MCP server.
 *
 * Any MCP client (Claude Code, Cursor, an inspector) can POST streamable-HTTP
 * JSON-RPC to /mcp and use Meridian's routed inference, research and browsing
 * as tools. Authentication is the gateway's normal API key; the endpoint is
 * deliberately not public.
 */

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'meridian_chat',
    description:
      'Send a prompt through Meridian\'s router: it picks the best available model under free-first economics and returns the reply with which model and provider served it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user prompt' },
        model: { type: 'string', description: 'Optional explicit model id; omit for automatic routing' },
        mode: { type: 'string', description: 'Routing mode, e.g. FREE_FIRST, CHEAP_FIRST, QUALITY_FIRST' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'meridian_models',
    description: 'List the models currently available through this gateway, with provider and pricing kind.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'meridian_scrape',
    description:
      'Fetch a web page with Meridian\'s research engine (robots-aware, rate-limited, cached) and return its readable text and links.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The http(s) URL to read' } },
      required: ['url'],
    },
  },
  {
    name: 'meridian_extract',
    description: 'Extract structured fields from a web page. Deterministic DOM/accessibility extraction first, then a model if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        objective: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name', 'description'],
          },
        },
      },
      required: ['url', 'fields'],
    },
  },
];

export async function registerMcpServerEndpoint(server: FastifyInstance, app: App): Promise<void> {
  server.post('/mcp', async (req, reply) => {
    requireScope(req, 'inference');
    const msg = (req.body ?? {}) as JsonRpcRequest;

    // Notifications get a 202 and no body, per streamable HTTP.
    if (msg.method && msg.id === undefined) {
      reply.code(202);
      return null;
    }

    const respond = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

    try {
      switch (msg.method) {
        case 'initialize':
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'meridian', version: MERIDIAN_VERSION },
          });
        case 'ping':
          return respond({});
        case 'tools/list':
          return respond({ tools: TOOLS });
        case 'tools/call':
          return respond(await callTool(app, req.auth.userId, msg.params ?? {}));
        default:
          return fail(-32601, `Method ${msg.method ?? '(none)'} is not supported`);
      }
    } catch (e) {
      return fail(-32000, e instanceof Error ? e.message : String(e));
    }
  });
}

async function callTool(
  app: App,
  userId: string | null,
  params: Record<string, unknown>,
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const text = (value: unknown): { content: { type: 'text'; text: string }[]; isError: boolean } => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1).slice(0, 60_000) }],
    isError: false,
  });

  switch (name) {
    case 'meridian_chat': {
      const result = await app.executor.chat(
        {
          modality: 'text',
          taskType: 'chat',
          model: typeof args.model === 'string' ? args.model : null,
          provider: null,
          pool: null,
          mode: normalizeModeLoose(args.mode),
          userId,
          workspaceId: null,
        },
        { messages: [{ role: 'user', content: String(args.prompt ?? '') }], maxTokens: 2000 },
      );
      return text({ reply: result.value.content, model: result.modelId, provider: result.providerId });
    }
    case 'meridian_models':
      return text(
        app.models
          .all()
          .slice(0, 200)
          .map((m) => ({ id: m.id, provider: m.providerId, pricing: m.pricing?.kind ?? 'UNKNOWN' })),
      );
    case 'meridian_scrape': {
      const { snapshot, fromCache, robots } = await app.control.research.scrape({ url: String(args.url ?? '') });
      return text({
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text.slice(0, 30_000),
        links: snapshot.elements.filter((e) => e.href).slice(0, 60).map((e) => ({ name: e.name, href: e.href })),
        fromCache,
        robots,
      });
    }
    case 'meridian_extract': {
      const record = await app.control.research.extract({
        url: String(args.url ?? ''),
        objective: String(args.objective ?? 'extract the requested fields'),
        fields: Array.isArray(args.fields) ? (args.fields as { name: string; description: string }[]).slice(0, 30) : [],
      });
      return text({ data: record.data, method: record.method, confidence: record.confidence, error: record.error, source: record.finalUrl });
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  }
}

function normalizeModeLoose(v: unknown): 'FREE_FIRST' | 'CHEAP_FIRST' | 'QUALITY_FIRST' | 'AUTO' | undefined {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'FREE_FIRST' || s === 'CHEAP_FIRST' || s === 'QUALITY_FIRST' || s === 'AUTO' ? s : undefined;
}
