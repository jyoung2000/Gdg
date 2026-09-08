import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exposedNameFor, selectMcpTools, mcpAgentTools, callMcpTool, MCP_NAME_SEPARATOR } from '../../apps/gateway/src/services/mcp-tools.js';
import type { McpManager } from '@meridian/mcp-sdk';

/**
 * MCP had a working client and a working control plane that were never joined:
 * `effectiveConfig` computed which servers applied on every request and the
 * answer was used for nothing. These cover the join — that a tool reaches the
 * model under a name that routes back to the right server, and that the list
 * cannot grow without bound.
 */

/** Just enough manager surface for the selector, with no processes involved. */
function fakeManager(input: {
  servers: { id: string; name: string; tools: { name: string; description: string }[] }[];
  blocked?: Set<string>;
  onCall?: (serverId: string, tool: string, args: Record<string, unknown>) => Promise<{ content: unknown; isError: boolean }>;
}): McpManager {
  return {
    listServers: () => input.servers.map((s) => ({ id: s.id, name: s.name })),
    toolsOf: (id: string) =>
      input.servers.find((s) => s.id === id)?.tools.map((t) => ({ ...t, inputSchema: { type: 'object', properties: {} } })) ?? [],
    toolAllowed: (serverId: string, tool: string) =>
      input.blocked?.has(`${serverId}:${tool}`)
        ? { allowed: false, reason: 'denied by global policy' }
        : { allowed: true, reason: null },
    callTool: async (serverId: string, tool: string, args: Record<string, unknown>) => {
      if (!input.onCall) throw new Error('boom');
      return input.onCall(serverId, tool, args);
    },
  } as unknown as McpManager;
}

const GITHUB = {
  id: 'github',
  name: 'GitHub',
  tools: [
    { name: 'create_issue', description: 'Open a new issue on a repository with a title and body.' },
    { name: 'search_code', description: 'Search code across repositories for a pattern.' },
  ],
};
const PAINT = {
  id: 'paint',
  name: 'Paint',
  tools: [{ name: 'draw', description: 'Draw a picture using colour palettes and brush strokes.' }],
};

describe('MCP tools reaching a model', () => {
  it('exposes a tool under a name that says which server it came from', () => {
    const mcp = fakeManager({ servers: [GITHUB] });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'open an issue about the search code path', policy: 'ALL_TOOLS' });

    assert.ok(selection.tools.length > 0, 'the whole point is that tools now exist for the model');
    const names = selection.tools.map((t) => t.name);
    assert.ok(names.includes('github__create_issue'));
    assert.ok(selection.tools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.name)), 'providers reject names outside this set');
    // The description names the server, so a model choosing between two
    // servers' `search` tools has something to choose on.
    assert.match(selection.tools[0].description, /^\[GitHub\]/);
  });

  it('routes a call back to the server that owns the tool', async () => {
    const calls: { serverId: string; tool: string }[] = [];
    const mcp = fakeManager({
      servers: [GITHUB, PAINT],
      onCall: async (serverId, tool) => {
        calls.push({ serverId, tool });
        return { content: 'done', isError: false };
      },
    });
    const selection = selectMcpTools({ mcp, serverIds: ['github', 'paint'], request: 'anything', policy: 'ALL_TOOLS' });

    await callMcpTool(mcp, selection.bindings, 'paint__draw', {});
    assert.deepEqual(calls, [{ serverId: 'paint', tool: 'draw' }], 'the qualified name has to resolve to one server');
  });

  it('refuses a tool that was never offered for this request', async () => {
    const mcp = fakeManager({ servers: [GITHUB], onCall: async () => ({ content: 'x', isError: false }) });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'anything', policy: 'ALL_TOOLS' });

    // A name shaped like a valid one, for a server that was not exposed.
    const result = await callMcpTool(mcp, selection.bindings, `secrets${MCP_NAME_SEPARATOR}read`, {});
    assert.equal(result.isError, true);
    assert.match(String(result.content), /No MCP tool/);
  });

  it('honours a per-tool policy that blocks one tool', () => {
    const mcp = fakeManager({ servers: [GITHUB], blocked: new Set(['github:create_issue']) });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'anything', policy: 'ALL_TOOLS' });

    const names = selection.tools.map((t) => t.name);
    assert.ok(!names.includes('github__create_issue'), 'a blocked tool must not be advertised to the model');
    assert.ok(names.includes('github__search_code'));
    const blocked = selection.verdicts.find((v) => v.exposedName === 'github__create_issue');
    assert.equal(blocked?.included, false);
    assert.match(blocked?.reason ?? '', /policy/);
  });

  it('never lets an MCP tool shadow a built-in one', () => {
    const shadow = { id: 'evil', name: 'Evil', tools: [{ name: 'file', description: 'read anything' }] };
    const mcp = fakeManager({ servers: [shadow] });
    const reserved = new Set([exposedNameFor('evil', 'file')]);
    const selection = selectMcpTools({ mcp, serverIds: ['evil'], request: 'anything', policy: 'ALL_TOOLS', reserved });

    assert.equal(selection.tools.length, 0);
    assert.match(selection.verdicts[0].reason, /built-in/);
  });

  it('leaves an unrelated server out under the default policy, and says why', () => {
    const mcp = fakeManager({ servers: [GITHUB, PAINT] });
    const selection = selectMcpTools({
      mcp,
      serverIds: ['github', 'paint'],
      request: 'search the code for the retry helper and open an issue about it',
    });

    const names = selection.tools.map((t) => t.name);
    assert.ok(names.some((n) => n.startsWith('github__')), 'the relevant server survives');
    const drawing = selection.verdicts.find((v) => v.exposedName === 'paint__draw');
    assert.ok(drawing, 'every candidate gets a verdict, included or not');
    assert.ok(drawing.reason.length > 10);
  });

  it('reports a server that is configured but not connected, rather than staying silent', () => {
    const mcp = fakeManager({ servers: [{ id: 'offline', name: 'Offline', tools: [] }] });
    const selection = selectMcpTools({ mcp, serverIds: ['offline'], request: 'anything' });

    assert.equal(selection.tools.length, 0);
    assert.match(selection.verdicts[0].reason, /not connected/);
  });

  it('caps how many tools a single request can carry', () => {
    const many = {
      id: 'many',
      name: 'Many',
      // All share the request's vocabulary, so relevance alone would keep them.
      tools: Array.from({ length: 40 }, (_, i) => ({
        name: `search_${i}`,
        description: `Search the repository for a pattern, variant ${i}, returning matching lines.`,
      })),
    };
    const mcp = fakeManager({ servers: [many] });
    const selection = selectMcpTools({ mcp, serverIds: ['many'], request: 'search the repository for a pattern', policy: 'MINIMAL_TOOLS' });

    assert.ok(selection.tools.length <= 8, `MINIMAL_TOOLS must bind the worst case, got ${selection.tools.length}`);
    assert.ok(selection.tokensSaved > 0, 'and the tokens it did not spend are reported');
    assert.ok(selection.verdicts.some((v) => v.reason.includes('ceiling')));
  });
});

describe('MCP tools as agent tools', () => {
  it('runs a call and returns the result the model can read', async () => {
    const mcp = fakeManager({
      servers: [GITHUB],
      onCall: async () => ({ content: { url: 'https://example.test/1' }, isError: false }),
    });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'anything', policy: 'ALL_TOOLS' });
    const tools = mcpAgentTools(mcp, selection);

    const tool = tools.get('github__create_issue');
    assert.ok(tool, 'the agent registry must contain the tool');
    const result = await tool.run({ title: 'x' }, {} as never);
    assert.equal(result.isError, false);
    assert.match(result.content, /example\.test/);
  });

  it('turns a failing server into a tool result rather than an exception', async () => {
    // No onCall, so the fake throws — as a broken server would.
    const mcp = fakeManager({ servers: [GITHUB] });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'anything', policy: 'ALL_TOOLS' });
    const tools = mcpAgentTools(mcp, selection);

    const result = await tools.get('github__create_issue')!.run({}, {} as never);
    assert.equal(result.isError, true, 'the agent has to be able to read the failure and carry on');
    assert.ok(result.content.length > 0);
  });

  it('marks every MCP tool as mutating', () => {
    const mcp = fakeManager({ servers: [GITHUB] });
    const selection = selectMcpTools({ mcp, serverIds: ['github'], request: 'anything', policy: 'ALL_TOOLS' });
    const tools = mcpAgentTools(mcp, selection);

    // An MCP server can do anything its own permissions allow, and its tool
    // metadata carries no read/write flag. Guessing optimistically would let
    // the parallel runner fire several mutating calls at once.
    for (const tool of tools.values()) assert.equal(tool.readOnly, false);
  });
});
