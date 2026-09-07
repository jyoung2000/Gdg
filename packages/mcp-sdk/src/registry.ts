import { MeridianError } from '@meridian/shared';
import type { CatalogEntry, InstallPlan, McpPermissionLevel } from './types.js';

/**
 * Where installable servers come from: the official MCP registry, queried
 * live, and a small curated catalog for servers Meridian integrates with
 * first-class. No aggregator is mandatory — a user can always add a server by
 * command or URL without any registry involved.
 */

const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

interface RegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  remotes?: { type?: string; url?: string }[];
  packages?: {
    registryType?: string;
    registry_type?: string;
    identifier?: string;
    version?: string;
    runtimeHint?: string;
    environmentVariables?: { name?: string; description?: string; isSecret?: boolean; isRequired?: boolean }[];
  }[];
}

/** Build the concrete, user-visible install plans an entry actually declares. */
function plansFor(server: RegistryServer): InstallPlan[] {
  const plans: InstallPlan[] = [];
  for (const remote of server.remotes ?? []) {
    if (!remote.url || !/^https:\/\//.test(remote.url)) continue;
    plans.push({
      kind: 'http',
      transport: 'http',
      command: null,
      args: [],
      url: remote.url,
      display: `Connect to ${remote.url}`,
      note: remote.type === 'sse' ? 'Legacy SSE transport' : null,
    });
  }
  for (const pkg of server.packages ?? []) {
    const type = (pkg.registryType ?? pkg.registry_type ?? '').toLowerCase();
    const id = pkg.identifier;
    if (!id) continue;
    const versioned = pkg.version ? `${id}@${pkg.version}` : id;
    if (type === 'npm') {
      plans.push({
        kind: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', versioned],
        url: null,
        display: `npx -y ${versioned}`,
        note: null,
      });
    } else if (type === 'pypi') {
      const spec = pkg.version ? `${id}==${pkg.version}` : id;
      plans.push({
        kind: 'uvx',
        transport: 'stdio',
        command: 'uvx',
        args: ['--from', spec, pkg.runtimeHint && pkg.runtimeHint !== 'uvx' ? pkg.runtimeHint : id],
        url: null,
        display: `uvx --from '${spec}' ${pkg.runtimeHint && pkg.runtimeHint !== 'uvx' ? pkg.runtimeHint : id}`,
        note: 'Requires uv (https://docs.astral.sh/uv/)',
      });
    } else if (type === 'oci') {
      plans.push({
        kind: 'docker',
        transport: 'stdio',
        command: 'docker',
        args: ['run', '--rm', '-i', versioned.replace('@', ':')],
        url: null,
        display: `docker run --rm -i ${versioned.replace('@', ':')}`,
        note: 'Runs as a container; needs Docker available to the gateway',
      });
    }
  }
  return plans;
}

function envHintsFor(server: RegistryServer): CatalogEntry['envHints'] {
  const seen = new Map<string, CatalogEntry['envHints'][number]>();
  for (const pkg of server.packages ?? []) {
    for (const env of pkg.environmentVariables ?? []) {
      if (!env.name || seen.has(env.name)) continue;
      const secret = env.isSecret ?? /key|token|secret|password/i.test(env.name);
      seen.set(env.name, { name: env.name, description: env.description ?? '', secret });
    }
  }
  return Array.from(seen.values());
}

export async function searchOfficialRegistry(query: string, limit = 20): Promise<CatalogEntry[]> {
  const url = `${OFFICIAL_REGISTRY}?limit=${Math.min(limit, 50)}${query ? `&search=${encodeURIComponent(query)}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new MeridianError('provider_unavailable', `The MCP registry is unreachable: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new MeridianError('provider_unavailable', `The MCP registry answered ${res.status}`);
  const body = (await res.json()) as { servers?: { server?: RegistryServer; _meta?: Record<string, { status?: string; isLatest?: boolean }> }[] };

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of body.servers ?? []) {
    const server = item.server;
    if (!server?.name || seen.has(server.name)) continue;
    const official = item._meta?.['io.modelcontextprotocol.registry/official'];
    if (official?.status && official.status !== 'active') continue;
    const installs = plansFor(server);
    if (installs.length === 0) continue;
    seen.add(server.name);
    entries.push({
      id: `reg:${server.name}`,
      name: server.name,
      title: server.title ?? server.name,
      description: (server.description ?? '').slice(0, 400),
      category: 'registry',
      source: 'official-registry',
      installs,
      homepage: server.websiteUrl ?? null,
      envHints: envHintsFor(server),
      suggestedPermissionLevel: 'safe',
    });
  }
  return entries;
}

/**
 * Servers Meridian treats as first-class. Each entry's install command is
 * exactly what its own documentation publishes — shown to the user before
 * anything executes.
 */
export function curatedCatalog(): CatalogEntry[] {
  const mk = (
    id: string,
    title: string,
    description: string,
    category: string,
    installs: InstallPlan[],
    envHints: CatalogEntry['envHints'],
    level: McpPermissionLevel,
    homepage: string,
  ): CatalogEntry => ({
    id: `cur:${id}`,
    name: id,
    title,
    description,
    category,
    source: 'curated',
    installs,
    homepage,
    envHints,
    suggestedPermissionLevel: level,
  });

  return [
    mk(
      'browser-harness',
      'Browser Harness (browser-use)',
      'Drive your real Chrome over CDP: tabs, clicks, typing, screenshots, JS, uploads and recordings, exposed as browser_* MCP tools. Needs your browser started with remote debugging (chrome://inspect); see the browser-harness install guide.',
      'browser-automation',
      [
        {
          kind: 'uvx',
          transport: 'stdio',
          command: 'uvx',
          args: ['--from', 'browser-harness[mcp]', 'browser-harness-mcp'],
          url: null,
          display: "uvx --from 'browser-harness[mcp]' browser-harness-mcp",
          note: 'Requires uv and Python 3.11+; connects to Chrome CDP on 9222/9223',
        },
      ],
      [{ name: 'BROWSER_USE_API_KEY', description: 'Only needed for Browser Use Cloud remote browsers', secret: true }],
      'development',
      'https://github.com/browser-use/browser-harness',
    ),
    mk(
      'filesystem',
      'Filesystem (reference)',
      'Read, write and search files under directories you explicitly allow.',
      'files',
      [
        {
          kind: 'npx',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          url: null,
          display: 'npx -y @modelcontextprotocol/server-filesystem <allowed-dir>',
          note: 'Append the directories to expose as extra args',
        },
      ],
      [],
      'development',
      'https://github.com/modelcontextprotocol/servers',
    ),
    mk(
      'fetch',
      'Fetch (reference)',
      'Fetch web pages and convert them to markdown for models.',
      'web',
      [
        {
          kind: 'uvx',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-fetch'],
          url: null,
          display: 'uvx mcp-server-fetch',
          note: 'Requires uv',
        },
      ],
      [],
      'safe',
      'https://github.com/modelcontextprotocol/servers',
    ),
    mk(
      'memory',
      'Memory (reference)',
      'A knowledge-graph memory the model can read and write across sessions.',
      'memory',
      [
        {
          kind: 'npx',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          url: null,
          display: 'npx -y @modelcontextprotocol/server-memory',
          note: null,
        },
      ],
      [],
      'safe',
      'https://github.com/modelcontextprotocol/servers',
    ),
    mk(
      'everything',
      'Everything (protocol test)',
      'The MCP reference test server: every protocol feature, for exercising clients. Useful in the playground.',
      'testing',
      [
        {
          kind: 'npx',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
          url: null,
          display: 'npx -y @modelcontextprotocol/server-everything',
          note: null,
        },
      ],
      [],
      'safe',
      'https://github.com/modelcontextprotocol/servers',
    ),
  ];
}
