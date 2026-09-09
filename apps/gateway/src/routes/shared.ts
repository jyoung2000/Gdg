import type { FastifyReply } from 'fastify';
import type { ChatMessage } from '@meridian/shared';
import type { App } from '../services/app.js';
import { MeridianError, ROUTING_MODES } from '@meridian/shared';
import { DEFAULT_PORT as PORT, type RoutingMode } from '@meridian/shared';

export const DEFAULT_PORT = PORT;

/* ------------------------------------------------------------------ */
/* Project knowledge                                                   */
/* ------------------------------------------------------------------ */

/**
 * Budgets for how much of a project reaches the

/**
 * The six modes surfaced as the primary control. The rest are the explicit
 * policies, shown behind "Advanced" — presenting fifteen equal choices would
 * make the common case harder, not more powerful.
 */
export const MODE_DESCRIPTION_KEYS: RoutingMode[] = ['AUTO', 'BEST', 'FAST', 'CHEAP', 'FREE', 'LOCAL'];

/** Parse a positive integer query parameter, with a bound and a default. */
export function intParam(raw: unknown, dflt: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

/**
 * Start a server-sent-event response, keeping the headers Fastify already set.
 *
 * Writing to `reply.raw` bypasses Fastify's own header serialisation and its
 * `onSend` hooks, so anything the request hooks accumulated — the security
 * headers, the request id, the idempotency disposition — is silently dropped
 * unless it is carried over here. A streamed response is not a place to have
 * weaker headers than a buffered one.
 */
export function beginSse(reply: FastifyReply, extra: Record<string, string> = {}): void {
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string | number | string[]>),
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx buffers SSE by default, which turns a live stream into one late blob.
    'x-accel-buffering': 'no',
    ...extra,
  });
}


/**
 * Refuse an unknown routing mode rather than silently treating it as AUTO.
 *
 * `--mode local` degrading to AUTO is worse than an error: the caller asked for
 * a privacy-relevant constraint and got a shrug. Case is forgiven — the CLI and
 * humans write `fast`; the vocabulary is uppercase — but a value outside the
 * vocabulary is a mistake the caller needs to hear about.
 */
export function normalizeMode(raw: unknown): RoutingMode | undefined {
  if (raw == null || raw === '') return undefined;
  const candidate = String(raw).toUpperCase();
  if ((ROUTING_MODES as readonly string[]).includes(candidate)) return candidate as RoutingMode;
  throw new MeridianError('invalid_request', `Unknown routing mode "${String(raw)}". One of: ${ROUTING_MODES.join(', ')}`);
}

/**
 * Prepend the skills a request resolves to, as a system message.
 *
 * This is the join between the control plane and the runtime: whatever the
 * effective-config resolver says is active is exactly what the model is told,
 * on this request, right now. Without this call the Skills screen would be a
 * set of toggles that change nothing — the failure mode the whole feature
 * exists to avoid.
 *
 * The skill block goes ahead of the conversation, so the caller's own system
 * message still follows it and a user instruction outranks a configured skill.
 */
export function withSkills(
  app: App,
  messages: ChatMessage[],
  ctx: { profileId?: string | null; modelId?: string | null; providerId?: string | null; workspaceId?: string | null; sessionId?: string | null },
): { messages: ChatMessage[]; applied: number; tokens: number } {
  const config = app.ai.profiles.effectiveConfig(ctx);
  if (!config.skills.length) return { messages, applied: 0, tokens: 0 };
  const prompt = app.ai.profiles.skillPrompt(config);
  if (!prompt) return { messages, applied: 0, tokens: 0 };
  return {
    messages: [{ role: 'system', content: `The operator has configured the following skills for you.\n\n${prompt}` }, ...messages],
    applied: config.skills.length,
    tokens: config.skillTokens,
  };
}

/** The file a project keeps its standing instructions in, at its folder root. */
export const PROJECT_INSTRUCTIONS_FILE = 'MERIDIAN.md';
/** How much project-file content to inline before it costs more than it helps. */
const PROJECT_KNOWLEDGE_BUDGET = 24_000;
const PROJECT_MAX_FILES = 60;
const PROJECT_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp',
  'hpp', 'cs', 'php', 'swift', 'sh', 'sql', 'html', 'css', 'scss', 'xml', 'vue', 'svelte',
]);

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && PROJECT_TEXT_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Give the model the project it is working in: its standing instructions and
 * the contents of the folder it shares.
 *
 * This is what makes a Meridian project behave like the ones people know from
 * other assistants — a folder of files every message can reference, plus
 * special instructions that always apply. It is deliberately real rather than a
 * label: the model literally receives a manifest of the folder and the text of
 * its files, up to a bounded budget, and the instructions come from a file that
 * lives in the folder itself (`MERIDIAN.md`), so the knowledge travels with the
 * project rather than hiding in a database.
 *
 * Nothing is fabricated: an empty or missing project contributes nothing, and
 * files past the budget are named in the manifest but not inlined, so the model
 * knows they exist and can ask to read them.
 */
export async function withProjectKnowledge(
  app: App,
  messages: ChatMessage[],
  workspaceId: string | null | undefined,
): Promise<{ messages: ChatMessage[]; applied: boolean; files: number; tokens: number }> {
  if (!workspaceId) return { messages, applied: false, files: 0, tokens: 0 };
  const record = app.store.getWorkspace(workspaceId);
  const ws = app.workspaceFor(workspaceId);
  if (!record || !ws) return { messages, applied: false, files: 0, tokens: 0 };

  let instructions = '';
  try {
    instructions = (await ws.read(PROJECT_INSTRUCTIONS_FILE)).trim();
  } catch {
    // No instruction file is normal; the folder alone is still knowledge.
  }

  let files: string[] = [];
  try {
    files = (await ws.listFiles(5000)).filter((f) => f !== PROJECT_INSTRUCTIONS_FILE).sort();
  } catch {
    files = [];
  }

  if (!instructions && files.length === 0) return { messages, applied: false, files: 0, tokens: 0 };

  const shown = files.slice(0, PROJECT_MAX_FILES);
  const manifest = shown.join('\n') + (files.length > shown.length ? `\n… and ${files.length - shown.length} more` : '');

  // Inline text files, cheapest-to-read first, until the budget is spent. The
  // rest stay in the manifest as names the model can ask about.
  const blocks: string[] = [];
  let budget = PROJECT_KNOWLEDGE_BUDGET;
  for (const path of shown) {
    if (budget <= 0) break;
    if (!isTextPath(path)) continue;
    try {
      const body = (await ws.read(path)).slice(0, budget);
      budget -= body.length;
      blocks.push(`File \`${path}\`:\n\n\`\`\`\n${body}\n\`\`\``);
    } catch {
      // A file that cannot be read is simply left in the manifest.
    }
  }

  const header = `You are working inside the project "${(record.name as string) ?? workspaceId}". Everything below is shared project context that applies to this whole conversation.`;
  const parts = [header];
  if (instructions) parts.push(`Project instructions:\n\n${instructions}`);
  parts.push(`Project files (${files.length}):\n${manifest}`);
  if (blocks.length) parts.push(`Contents of the project's files:\n\n${blocks.join('\n\n')}`);

  const block = parts.join('\n\n');
  return {
    messages: [{ role: 'system', content: block }, ...messages],
    applied: true,
    files: files.length,
    tokens: Math.ceil(block.length / 4),
  };
}

/**
 * The one way a request's context is assembled, for every dialect.
 *
 * There used to be three of these and they disagreed: `/v1/chat/completions`
 * applied project knowledge and skills, `/anthropic/v1/messages` applied
 * skills only, and `/v1/responses` applied neither — while all three accepted
 * the same `meridian.workspace_id` and `meridian.profile_id` extensions and
 * said nothing about ignoring them. A caller who selected a project got a
 * model that knew about it or one that did not, depending on which dialect
 * their client happened to speak.
 *
 * Order matters and is the same everywhere: the project first, so the standing
 * instructions and the shared folder frame everything; then the operator's
 * skills; then the conversation.
 */
export async function assembleContext(
  app: App,
  messages: ChatMessage[],
  ctx: { profileId?: string | null; modelId?: string | null; providerId?: string | null; workspaceId?: string | null; sessionId?: string | null },
): Promise<{ messages: ChatMessage[]; project: { applied: boolean; files: number; tokens: number }; skills: { applied: number; tokens: number } }> {
  const project = await withProjectKnowledge(app, messages, ctx.workspaceId ?? null);
  const skills = withSkills(app, project.messages, ctx);
  return {
    messages: skills.messages,
    project: { applied: project.applied, files: project.files, tokens: project.tokens },
    skills: { applied: skills.applied, tokens: skills.tokens },
  };
}
