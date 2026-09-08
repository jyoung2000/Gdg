/**
 * The join between MCP and inference.
 *
 * Everything on both sides of this file already worked. The MCP client really
 * spawns servers and really calls their tools; the control plane really
 * resolves which servers apply to a request across six scopes. They had never
 * been connected: `effectiveConfig` computed `mcpServers` on every request and
 * the result was used for nothing but rendering an explanation. No MCP tool had
 * ever been serialised into a model request, on any code path, so every scope
 * toggle and per-tool policy in the product was, at inference time, decoration.
 *
 * Two things had to be true before wiring it was safe.
 *
 * **Names have to survive a round trip.** Two servers may both expose `search`,
 * and a model that calls `search` has to reach the right one. Tools are exposed
 * under a qualified name, and the mapping back is exact rather than guessed.
 *
 * **The tool list has to be bounded.** Tool schemas are the single largest
 * avoidable cost in a prompt — a dozen servers can put more tokens in the tool
 * array than the conversation contains. Exposing everything from everything
 * would have handed that straight to the context budget, so selection is part
 * of this from the start rather than a later optimisation.
 */
import { estimateToolTokens, type ToolDefinition } from '@meridian/shared';
import { select, type RelevanceCandidate } from '@meridian/context-sdk';
import type { McpManager } from '@meridian/mcp-sdk';
import type { Tool as AgentTool } from '@meridian/agent-sdk';

/**
 * Separator between a server id and a tool name.
 *
 * A double underscore rather than a dot or a slash: several providers restrict
 * tool names to `[a-zA-Z0-9_-]`, and a name the provider rejects would fail the
 * whole request rather than just that tool.
 */
export const MCP_NAME_SEPARATOR = '__';

/** How tools are chosen for a request. */
export type McpToolPolicy = 'ALL_TOOLS' | 'RELEVANT_TOOLS' | 'MINIMAL_TOOLS';

export interface McpToolBinding {
  /** The name the model sees, e.g. `github__create_issue`. */
  exposedName: string;
  serverId: string;
  serverName: string;
  /** The tool's own name, as the server knows it. */
  toolName: string;
  definition: ToolDefinition;
  estimatedTokens: number;
}

export interface McpToolSelection {
  tools: ToolDefinition[];
  bindings: Map<string, McpToolBinding>;
  /** Every tool considered, and why it was included or not. */
  verdicts: { exposedName: string; included: boolean; reason: string }[];
  /** Tokens not spent because a tool was left out. */
  tokensSaved: number;
  /** Tokens the included tools do cost. */
  tokensSpent: number;
}

/**
 * Qualify a tool name with its server.
 *
 * Server ids are already slug-shaped, but a hostile or careless one could
 * contain a character the provider rejects, so this normalises rather than
 * trusting.
 */
export function exposedNameFor(serverId: string, toolName: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe(serverId)}${MCP_NAME_SEPARATOR}${safe(toolName)}`;
}

const MAX_TOOLS = {
  ALL_TOOLS: Number.POSITIVE_INFINITY,
  RELEVANT_TOOLS: 24,
  MINIMAL_TOOLS: 8,
} as const;

/**
 * Which MCP tools this request should be able to call.
 *
 * `serverIds` comes from the control plane's effective configuration, so a
 * server that is not assigned to this scope never reaches here. Within that,
 * three gates apply in order: the server has to be connected (an unreachable
 * server's tools would be advertised and then fail), the per-tool policy has to
 * allow it, and — under `RELEVANT_TOOLS` — it has to look relevant to the
 * request.
 *
 * The default is `RELEVANT_TOOLS` because the alternative is unbounded: the
 * tool array grows with every server the operator installs, whether or not this
 * request could use any of them.
 */
export function selectMcpTools(input: {
  mcp: McpManager;
  serverIds: string[];
  request: string;
  policy?: McpToolPolicy;
  context?: { workspaceId?: string | null; sessionId?: string | null };
  /** Tool names the caller already offers; an MCP tool never shadows one. */
  reserved?: Set<string>;
}): McpToolSelection {
  const policy = input.policy ?? 'RELEVANT_TOOLS';
  const reserved = input.reserved ?? new Set<string>();
  const verdicts: McpToolSelection['verdicts'] = [];
  const bindings = new Map<string, McpToolBinding>();
  const candidates: (RelevanceCandidate & { binding: McpToolBinding })[] = [];

  for (const serverId of input.serverIds) {
    const spec = input.mcp.listServers().find((s) => s.id === serverId);
    if (!spec) continue;
    const tools = input.mcp.toolsOf(serverId);
    if (!tools.length) {
      // A server with no tools is not an error: it may simply not be connected
      // yet. Saying so is more useful than silence when a model cannot find a
      // tool the operator believes they enabled.
      verdicts.push({
        exposedName: `${serverId}${MCP_NAME_SEPARATOR}*`,
        included: false,
        reason: 'the server is not connected, so its tools are unknown right now',
      });
      continue;
    }

    for (const tool of tools) {
      const exposedName = exposedNameFor(serverId, tool.name);
      const allowed = input.mcp.toolAllowed(serverId, tool.name, input.context);
      if (!allowed.allowed) {
        verdicts.push({ exposedName, included: false, reason: allowed.reason ?? 'blocked by policy' });
        continue;
      }
      if (reserved.has(exposedName)) {
        verdicts.push({ exposedName, included: false, reason: 'a built-in tool already uses this name' });
        continue;
      }

      const definition: ToolDefinition = {
        name: exposedName,
        // The server name is prepended so a model choosing between two servers'
        // `search` tools has something to choose on.
        description: `[${spec.name}] ${tool.description || tool.name}`,
        parameters: isObjectSchema(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
      };
      const binding: McpToolBinding = {
        exposedName,
        serverId,
        serverName: spec.name,
        toolName: tool.name,
        definition,
        estimatedTokens: estimateToolTokens(definition),
      };
      candidates.push({
        id: exposedName,
        text: `${tool.name} ${tool.description ?? ''} ${spec.name}`,
        estimatedTokens: binding.estimatedTokens,
        binding,
      });
    }
  }

  if (!candidates.length) return { tools: [], bindings, verdicts, tokensSaved: 0, tokensSpent: 0 };

  let chosen = candidates;
  let tokensSaved = 0;

  if (policy !== 'ALL_TOOLS') {
    const result = select(input.request, candidates);
    const included = new Set(result.included);
    for (const v of result.verdicts) {
      if (!v.included) verdicts.push({ exposedName: v.id, included: false, reason: v.reason });
    }
    tokensSaved += result.tokensSaved;
    chosen = candidates.filter((c) => included.has(c.id));
  }

  // A hard ceiling on top of relevance. Relevance is deliberately inclusive, so
  // on a request that happens to share vocabulary with everything it can select
  // most of a large catalogue; the cap keeps the worst case bounded. Cheapest
  // first, so the cut falls on the tools with the biggest schemas.
  const limit = MAX_TOOLS[policy];
  if (chosen.length > limit) {
    const sorted = [...chosen].sort((a, b) => a.estimatedTokens - b.estimatedTokens);
    const dropped = sorted.slice(limit);
    for (const d of dropped) {
      tokensSaved += d.estimatedTokens;
      verdicts.push({
        exposedName: d.id,
        included: false,
        reason: `beyond the ${limit}-tool ceiling for ${policy}; larger schemas are dropped first`,
      });
    }
    chosen = sorted.slice(0, limit);
  }

  let tokensSpent = 0;
  const tools: ToolDefinition[] = [];
  for (const c of chosen) {
    bindings.set(c.binding.exposedName, c.binding);
    tools.push(c.binding.definition);
    tokensSpent += c.binding.estimatedTokens;
    verdicts.push({ exposedName: c.id, included: true, reason: 'available to this request' });
  }

  return { tools, bindings, verdicts, tokensSaved, tokensSpent };
}

/**
 * Route a tool call the model made back to the server that owns it.
 *
 * Looked up in the bindings built for *this* request rather than parsed out of
 * the name, so a tool whose name happens to contain the separator cannot be
 * used to address a server that was never exposed.
 */
export async function callMcpTool(
  mcp: McpManager,
  bindings: Map<string, McpToolBinding>,
  exposedName: string,
  args: Record<string, unknown>,
  context?: { workspaceId?: string | null; sessionId?: string | null },
): Promise<{ content: unknown; isError: boolean }> {
  const binding = bindings.get(exposedName);
  if (!binding) {
    return { content: `No MCP tool named ${exposedName} was offered for this request.`, isError: true };
  }
  try {
    return await mcp.callTool(binding.serverId, binding.toolName, args, context);
  } catch (e) {
    // A failing MCP server is a tool result the model can react to, not an
    // exception that ends the turn — the same rule the built-in tools follow.
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return Boolean(schema) && typeof schema === 'object' && !Array.isArray(schema);
}

/**
 * Present the selected MCP tools as agent tools.
 *
 * This is the point at which MCP becomes usable rather than merely configured:
 * an agent's tool registry is what it can actually do, and until now nothing
 * from MCP was in it.
 *
 * Marked as mutating (`readOnly: false`) without exception. An MCP server can
 * do anything its own permissions allow — write files, post to an API, spend
 * money — and its tool metadata carries no read/write flag to tell them apart.
 * Guessing optimistically here would let the parallel runner fire off several
 * mutating calls at once on the assumption they were reads.
 */
export function mcpAgentTools(
  mcp: McpManager,
  selection: McpToolSelection,
  context?: { workspaceId?: string | null; sessionId?: string | null },
): Map<string, AgentTool> {
  const out = new Map<string, AgentTool>();
  for (const [exposedName, binding] of selection.bindings) {
    out.set(exposedName, {
      definition: binding.definition,
      readOnly: false,
      run: async (args) => {
        const result = await callMcpTool(mcp, selection.bindings, exposedName, args, context);
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2);
        return { content, isError: result.isError };
      },
    });
  }
  return out;
}
