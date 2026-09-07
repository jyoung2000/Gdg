import { randomUUID } from 'node:crypto';
import type { Logger, MeridianConfig } from '@meridian/shared';
import {
  BrowserManager,
  PlaywrightProvider,
  ResearchEngine,
  type BrowserEngineId,
  type BrowserProvider,
  type ProfileStore,
  type ResearchRecord,
} from '@meridian/browser-sdk';
import { McpManager, type McpStore, type SecretVault, type McpServerSpec, type McpToolPolicy, type McpPreset } from '@meridian/mcp-sdk';
import { DockerOrchestrator } from '@meridian/docker-sdk';
import type { Executor } from '@meridian/routing-sdk';
import type { Tool } from '@meridian/agent-sdk';
import type { Store } from '../db/store.js';
import type { EventBus } from './events.js';
import { GitService } from './git.js';

/**
 * The browser / MCP / docker / git control plane, assembled against the
 * gateway's store, vault and router. Kept out of app.ts so the service
 * container stays a wiring diagram rather than a construction site.
 */
export interface ControlPlane {
  browser: BrowserManager;
  research: ResearchEngine;
  mcp: McpManager;
  docker: DockerOrchestrator;
  git: GitService;
  /** Which engines were configured, for honest status reporting. */
  browserEngines: { lightpandaCdp: string | null; realBrowserCdp: string | null };
}

export function createControlPlane(opts: {
  config: MeridianConfig;
  store: Store;
  executor: Executor;
  events: EventBus;
  logger: Logger;
}): ControlPlane {
  const { store, executor, events, logger } = opts;

  /* ---- Browser ---------------------------------------------------- */

  const lightpandaCdp = process.env.MERIDIAN_LIGHTPANDA_CDP?.trim() || null;
  const realBrowserCdp = process.env.MERIDIAN_BROWSER_CDP_URL?.trim() || null;

  const providers: Partial<Record<BrowserEngineId, BrowserProvider>> = {
    chromium: new PlaywrightProvider({ engine: 'chromium', executablePath: process.env.MERIDIAN_CHROMIUM_PATH ?? null }),
  };
  if (lightpandaCdp) providers.lightpanda = new PlaywrightProvider({ engine: 'lightpanda', cdpUrl: lightpandaCdp });
  if (realBrowserCdp) providers.cdp = new PlaywrightProvider({ engine: 'cdp', cdpUrl: realBrowserCdp });

  const profileStore: ProfileStore = {
    load: async (name) => store.loadBrowserProfile(name),
    save: async (name, state, meta) => store.saveBrowserProfile(name, state, meta),
    list: async () => store.listBrowserProfiles(),
    remove: async (name) => store.deleteBrowserProfile(name),
  };

  const browser = new BrowserManager({
    providers,
    profiles: profileStore,
    defaultPolicy: {
      deny: (process.env.MERIDIAN_BROWSER_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      // The gateway's own UI is the first thing a session is asked to look at
      // in development, and container-internal service names are how compose
      // wiring reaches a project under test.
      allowPrivate: (process.env.MERIDIAN_BROWSER_ALLOW_PRIVATE ?? 'localhost,127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean),
    },
    onEvent: (sessionId, entry) => events.publish({ type: 'browser', sessionId, entry }),
  });

  /* ---- Research ---------------------------------------------------- */

  const research = new ResearchEngine({
    manager: browser,
    persist: async (record: ResearchRecord) => store.saveResearchRecord(record.id, record, record.at),
    // The LLM leg goes through the normal router with free-first economics:
    // structured extraction is a cheap task and must never silently spend.
    llmExtract: async (input) => {
      const prompt = [
        `Extract the following fields from this web page as strict JSON.`,
        `Objective: ${input.objective}`,
        `Fields:`,
        ...input.fields.map((f) => `- ${f.name} (${f.type ?? 'string'}): ${f.description}`),
        ``,
        `Respond with ONLY a JSON object: {"data": {<field>: <value or null>}, "confidence": <0..1>}.`,
        `Use null for anything the page does not state. Do not guess.`,
        ``,
        `URL: ${input.url}`,
        `Title: ${input.title}`,
        `Outline:\n${input.outline}`,
        ``,
        `Page text:\n${input.text}`,
      ].join('\n');
      const result = await executor.chat(
        {
          modality: 'text',
          taskType: 'extract',
          model: null,
          provider: null,
          pool: null,
          mode: 'FREE_FIRST',
          userId: null,
          workspaceId: null,
        },
        { messages: [{ role: 'user', content: prompt }], maxTokens: 1200, temperature: 0 },
      );
      const parsed = parseExtractionJson(result.value.content ?? '');
      return { data: parsed.data, confidence: parsed.confidence, modelId: result.modelId };
    },
  });

  /* ---- MCP --------------------------------------------------------- */

  const vault: SecretVault = {
    seal: async (value) => {
      const handle = `mcps_${randomUUID().replace(/-/g, '')}`;
      store.sealMcpSecret(handle, value);
      return handle;
    },
    open: async (handle) => {
      const value = store.openMcpSecret(handle);
      if (value == null) throw new Error('Unknown or unreadable secret handle');
      return value;
    },
    discard: async (handle) => store.discardMcpSecret(handle),
  };

  const mcpStore: McpStore = {
    loadServers: async () => store.listMcpServers() as McpServerSpec[],
    saveServer: async (spec) => store.saveMcpServer(spec.id, spec, spec.createdAt, spec.updatedAt),
    deleteServer: async (id) => store.deleteMcpServer(id),
    loadPolicies: async () => store.listMcpPolicies() as McpToolPolicy[],
    savePolicy: async (policy) => store.saveMcpPolicy(policy.id, policy),
    deletePolicy: async (id) => store.deleteMcpPolicy(id),
    loadPresets: async () => store.listMcpPresets() as McpPreset[],
    savePreset: async (preset) => store.saveMcpPreset(preset.id, preset),
    deletePreset: async (id) => store.deleteMcpPreset(id),
  };

  const mcp = new McpManager({
    store: mcpStore,
    vault,
    onLog: (serverId, line) => logger.debug('mcp server log', { serverId, detail: line.slice(0, 300) }),
  });

  /* ---- Docker & git ------------------------------------------------ */

  const docker = new DockerOrchestrator({
    // One namespace per gateway process: restarting the gateway abandons
    // nothing, because names are deterministic within a boot and cleanup
    // sweeps by label.
    sessionId: `gw${randomUUID().slice(0, 8)}`,
    onLog: (line) => logger.debug('docker', { detail: line.slice(0, 300) }),
  });

  const git = new GitService();

  return { browser, research, mcp, docker, git, browserEngines: { lightpandaCdp, realBrowserCdp } };
}

/**
 * Real-browser tools for the agent runtime.
 *
 * One browser session per task, created lazily and reaped by the manager's
 * idle timeout; the task's log and the session's log tell the same story.
 * These land in the shared registry, so any agent whose definition names them
 * can use them — and when no engine is available the tools exist but answer
 * honestly with the engine error.
 */
export function browserTools(control: ControlPlane): Tool[] {
  const sessions = new Map<string, string>();
  const out: Tool[] = [];

  async function sessionFor(taskId: string): Promise<string> {
    const existing = sessions.get(taskId);
    if (existing && control.browser.listSessions().some((s) => s.id === existing)) return existing;
    const info = await control.browser.createSession({ engine: 'auto', task: `agent task ${taskId}`, idleTimeoutMs: 180_000 });
    sessions.set(taskId, info.id);
    return info.id;
  }

  function summarize(snapshot: { url: string; title: string; text: string; elements: { ref: string; role: string; name: string; href?: string }[]; truncated: boolean }): string {
    const elements = snapshot.elements
      .slice(0, 60)
      .map((e) => `${e.ref} [${e.role}] ${e.name}${e.href ? ` -> ${e.href}` : ''}`)
      .join('\n');
    return [
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      '',
      snapshot.text.slice(0, 12_000),
      snapshot.truncated ? '\n[page content truncated]' : '',
      '',
      'Interactive elements (act on them with browser_act by ref):',
      elements || '(none found)',
    ].join('\n');
  }

  out.push({
    readOnly: true,
    definition: {
      name: 'browse',
      description:
        'Open a URL in a real browser (JavaScript executes) and return the rendered page: text, outline, and interactive elements with refs. Private/internal addresses are refused by policy.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to open' },
          wait_for_text: { type: 'string', description: 'Optionally wait until this text appears (client-rendered pages)' },
        },
        required: ['url'],
      },
    },
    run: async (args, ctx) => {
      try {
        const id = await sessionFor(ctx.taskId);
        let snapshot = await control.browser.navigate(id, String(args.url ?? ''));
        if (typeof args.wait_for_text === 'string' && args.wait_for_text) {
          snapshot = await control.browser.wait(id, { forText: args.wait_for_text });
        } else {
          for (let i = 0; i < 3 && snapshot.text.trim().length < 40; i++) {
            await control.browser.wait(id, { ms: 700 });
            snapshot = await control.browser.snapshot(id);
          }
        }
        return { content: summarize(snapshot), isError: false };
      } catch (e) {
        return { content: `Browse failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  });

  out.push({
    readOnly: false,
    definition: {
      name: 'browser_act',
      description:
        'Act in the browser page opened by browse: click/fill/select/press/scroll/wait using element refs from the last snapshot. Returns the updated page.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'fill', 'select', 'press', 'scroll', 'wait', 'back'], description: 'What to do' },
          ref: { type: 'string', description: 'Element ref such as e12 (click/fill/select)' },
          text: { type: 'string', description: 'Text to fill' },
          value: { type: 'string', description: 'Option value to select' },
          key: { type: 'string', description: 'Key to press, e.g. Enter' },
          direction: { type: 'string', enum: ['up', 'down'] },
          wait_for_text: { type: 'string' },
        },
        required: ['action'],
      },
    },
    run: async (args, ctx) => {
      try {
        const id = sessions.get(ctx.taskId);
        if (!id) return { content: 'No browser page is open for this task; call browse first.', isError: true };
        const action = String(args.action ?? '');
        const snap =
          action === 'click'
            ? await control.browser.click(id, { ref: String(args.ref ?? '') })
            : action === 'fill'
              ? await control.browser.fill(id, { ref: String(args.ref ?? ''), text: String(args.text ?? ''), submit: false })
              : action === 'select'
                ? await control.browser.select(id, { ref: String(args.ref ?? ''), value: String(args.value ?? '') })
                : action === 'press'
                  ? await control.browser.press(id, String(args.key ?? 'Enter'))
                  : action === 'scroll'
                    ? await control.browser.scroll(id, args.direction === 'up' ? 'up' : 'down')
                    : action === 'back'
                      ? await control.browser.back(id)
                      : await control.browser.wait(id, {
                          forText: typeof args.wait_for_text === 'string' ? args.wait_for_text : undefined,
                          ms: 800,
                        });
        return { content: summarize(snap), isError: false };
      } catch (e) {
        return { content: `Browser action failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  });

  out.push({
    readOnly: true,
    definition: {
      name: 'web_extract',
      description:
        'Extract structured fields from a web page (robots-aware; DOM and accessibility extraction first, a model only if needed). Returns the fields, the method used, and a confidence score.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          objective: { type: 'string', description: 'What you are trying to learn' },
          fields: {
            type: 'array',
            description: 'Fields to extract',
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
    run: async (args) => {
      try {
        const record = await control.research.extract({
          url: String(args.url ?? ''),
          objective: String(args.objective ?? 'extract the requested fields'),
          fields: Array.isArray(args.fields) ? (args.fields as { name: string; description: string }[]).slice(0, 20) : [],
        });
        return {
          content: JSON.stringify(
            { data: record.data, method: record.method, confidence: record.confidence, error: record.error, source: record.finalUrl },
            null,
            1,
          ),
          isError: record.error !== null && record.data == null,
        };
      } catch (e) {
        return { content: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  });

  return out;
}

/** Parse the extraction reply, tolerating fences and stray prose. */
function parseExtractionJson(text: string): { data: Record<string, unknown>; confidence: number } {
  const candidates = [text, /\{[\s\S]*\}/.exec(text)?.[0] ?? ''];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.replace(/^```(?:json)?|```$/gm, '').trim()) as {
        data?: Record<string, unknown>;
        confidence?: number;
      };
      if (parsed && typeof parsed === 'object') {
        return {
          data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { data: {}, confidence: 0 };
}
