#!/usr/bin/env node
/**
 * Generate the offline edition of the Meridian UI.
 *
 * One file, opened with file://, no server, no Node, no backend, no network.
 *
 * The thing that makes this worth having rather than a screenshot is that it
 * inlines the **production stylesheet** — the same `dist/web/assets/*.css` the
 * real application serves — and the markup uses the same class names. So the
 * offline edition cannot drift into being a separate design: change a token in
 * `packages/ui`, rebuild, regenerate, and this moves with it. A hand-written
 * imitation would have been a second design system to maintain, and it would
 * have started lying the first time someone adjusted a radius.
 *
 * What is simulated is the *backend*, not the interface. Navigation, drawers,
 * pickers, filters, the palette, task progress and the responsive behaviour are
 * all real DOM behaviour against deterministic local data.
 *
 *   node scripts/build-offline-ui.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintComment, uiFingerprint } from './ui-fingerprint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where to write. Overridable so a test can regenerate into a temporary
 * directory and compare bytes without mutating the tracked artefact — a test
 * that rewrites the thing it is checking is a test that can never fail twice.
 */
const outIndex = process.argv.indexOf('--out');
const OUT_DIR = outIndex >= 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : join(ROOT, 'offline-ui');

function fail(message) {
  process.stderr.write(`\nbuild-offline-ui: ${message}\n\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* The production stylesheet                                           */
/* ------------------------------------------------------------------ */

const assetsDir = join(ROOT, 'dist/web/assets');
if (!existsSync(assetsDir)) fail('dist/web has not been built. Run `pnpm build` first.');

const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
if (cssFiles.length === 0) fail(`no stylesheet in ${assetsDir}. Run \`pnpm build\` first.`);

let css = cssFiles.map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n');

// Vite emits `url(/assets/…)` for anything it copied. A file:// page resolves
// that against the filesystem root and silently fails, so an offline build must
// have none of them — and must say so rather than shipping a broken reference.
const externalUrls = [...css.matchAll(/url\((?!['"]?data:)([^)]+)\)/g)].map((m) => m[1].trim());
if (externalUrls.length) {
  fail(
    `the production stylesheet references ${externalUrls.length} external asset(s), which cannot resolve over file://:\n` +
      externalUrls.slice(0, 5).map((u) => `  ${u}`).join('\n') +
      '\n  Inline them as data: URIs, or the offline edition will render without them.',
  );
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic, and obviously not live.
 *
 * Shaped like what the real API returns so the layout is exercised honestly,
 * but every provider is a plausible public one with figures that are examples
 * rather than measurements. The header says OFFLINE PREVIEW and the Models
 * screen repeats it, because a demo catalogue that looked like live provider
 * data would be the one genuinely dishonest thing this file could do.
 */
const DATA = {
  models: [
    { id: 'groq:openai/gpt-oss-120b', name: 'gpt-oss-120b', provider: 'groq', access: 'Free daily quota', verdict: 'free', ctx: 131072, caps: ['tools', 'json'], quota: '30/min · 1,000/day', health: 'healthy', latency: 240, checked: '38d ago' },
    { id: 'google:gemini-2.5-flash', name: 'gemini-2.5-flash', provider: 'google', access: 'Free daily quota', verdict: 'free', ctx: 1000000, caps: ['vision', 'tools', 'json'], quota: '15/min · 1,500/day', health: 'healthy', latency: 410, checked: '38d ago' },
    { id: 'openrouter:llama-3.3-70b:free', name: 'llama-3.3-70b:free', provider: 'openrouter', access: 'Free daily quota', verdict: 'free', ctx: 65536, caps: ['tools'], quota: '50/day', health: 'healthy', latency: 890, checked: '2d ago' },
    { id: 'ollama:qwen2.5-coder', name: 'qwen2.5-coder', provider: 'ollama', access: 'Local — no API cost', verdict: 'local', ctx: 32768, caps: ['tools'], quota: 'Your hardware', health: 'healthy', latency: 120, checked: 'now' },
    { id: 'pollinations:flux', name: 'flux', provider: 'pollinations', access: 'Free tier', verdict: 'free', ctx: 0, caps: ['image'], quota: 'Rate-limited by address', health: 'degraded', latency: 3200, checked: '1d ago' },
    { id: 'anthropic:claude-sonnet-4', name: 'claude-sonnet-4', provider: 'anthropic', access: 'Paid', verdict: 'paid', ctx: 200000, caps: ['vision', 'tools', 'json', 'reasoning'], quota: '$3/M in · $15/M out', health: 'healthy', latency: 620, checked: 'now' },
    { id: 'huggingface:deepseek-v3', name: 'DeepSeek-V3', provider: 'huggingface', access: 'Recurring credit', verdict: 'credit', ctx: 163840, caps: ['tools'], quota: 'Monthly credit', health: 'healthy', latency: 1100, checked: '5d ago' },
    { id: 'cerebras:llama3.1-8b', name: 'llama3.1-8b', provider: 'cerebras', access: 'Free tier', verdict: 'unknown', ctx: 131072, caps: ['tools', 'json'], quota: 'Not established', health: 'unknown', latency: null, checked: '176d ago' },
  ],
  connections: [
    { id: 'groq', name: 'Groq', state: 'connected', key: 'gsk_••••••••4f2a', models: 14, health: 'healthy', trust: 'trusted', dataUse: 'Not used for training' },
    { id: 'google', name: 'Google AI Studio', state: 'connected', key: 'AIza••••••••9c1d', models: 22, health: 'healthy', trust: 'trusted', dataUse: 'Free tier may be reviewed' },
    { id: 'ollama', name: 'Ollama', state: 'connected', key: 'No key needed', models: 6, health: 'healthy', trust: 'verified', dataUse: 'Never leaves this machine' },
    { id: 'openrouter', name: 'OpenRouter', state: 'connected', key: 'sk-or••••••••7b3e', models: 312, health: 'degraded', trust: 'trusted', dataUse: 'Varies by upstream provider' },
    { id: 'anthropic', name: 'Anthropic', state: 'disconnected', key: null, models: 0, health: 'unknown', trust: 'verified', dataUse: 'Not used for training' },
  ],
  conversations: [
    { id: 'c1', title: 'Refactor the auth middleware', when: '12 minutes ago' },
    { id: 'c2', title: 'Why is the build failing on Windows?', when: 'Yesterday' },
    { id: 'c3', title: 'Summarise the Q3 incident reports', when: '3 days ago' },
  ],
  projects: [
    { id: 'p1', name: 'meridian', files: 428, chats: 12, note: 'The gateway itself' },
    { id: 'p2', name: 'field-notes', files: 36, chats: 4, note: 'Research writing' },
  ],
  activity: [
    { when: '12:04', model: 'gemini-2.5-flash', provider: 'google', tokens: '1,204', cost: 'Free', outcome: 'ok', ms: 410 },
    { when: '12:01', model: 'gpt-oss-120b', provider: 'groq', tokens: '3,880', cost: 'Free', outcome: 'ok', ms: 240 },
    { when: '11:58', model: 'llama-3.3-70b:free', provider: 'openrouter', tokens: '910', cost: 'Free', outcome: 'recovered', ms: 2100 },
    { when: '11:44', model: 'qwen2.5-coder', provider: 'ollama', tokens: '12,400', cost: 'Local', outcome: 'ok', ms: 120 },
    { when: '11:30', model: 'claude-sonnet-4', provider: 'anthropic', tokens: '8,110', cost: '$0.0412', outcome: 'ok', ms: 620 },
  ],
  tools: [
    { id: 'files', name: 'Files', on: true, note: 'Read and edit in the open project' },
    { id: 'shell', name: 'Shell', on: true, note: 'Run commands in the sandbox' },
    { id: 'browser', name: 'Browser', on: false, note: 'Fetch and read pages' },
    { id: 'mcp-github', name: 'GitHub (MCP)', on: true, note: 'Issues and pull requests' },
    { id: 'mcp-postgres', name: 'Postgres (MCP)', on: false, note: 'Read-only queries' },
    { id: 'computer', name: 'Computer', on: false, note: 'Control a desktop session' },
  ],
  taskStages: [
    { label: 'Inspect repository', state: 'done' },
    { label: 'Locate authentication', state: 'done' },
    { label: 'Implement fix', state: 'active' },
    { label: 'Run tests', state: 'todo' },
    { label: 'Review changes', state: 'todo' },
  ],
  routing: {
    selected: 'gemini-2.5-flash',
    provider: 'google',
    reasons: ['Free daily quota with 1,412 of 1,500 requests left', 'Vision required and probe-verified', 'Provider healthy, p95 410 ms', 'Credential configured'],
    rejected: [
      { what: 'claude-sonnet-4', why: 'Paid, and this request asked for Free' },
      { what: 'flux', why: 'Cannot serve a text request' },
      { what: 'llama3.1-8b', why: 'Cost is not established' },
      { what: 'llama-3.3-70b:free', why: 'Free, but 3 of 50 daily requests left' },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

const fingerprint = uiFingerprint(ROOT);

const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
${fingerprintComment(fingerprint)}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Meridian — offline preview</title>
<meta name="description" content="A self-contained offline preview of the Meridian interface. No installation, no server, no network.">
<style>
/* ==================================================================
   The production stylesheet, inlined verbatim from dist/web/assets.
   Not a copy maintained by hand: regenerating this file re-reads it,
   so the offline edition cannot drift away from the real one.
   ================================================================== */
${css}

/* ------------------------------------------------------------------
   The handful of rules the offline shell needs that the production
   app gets from its own layout. Deliberately small: everything that
   can come from the real stylesheet does.
   ------------------------------------------------------------------ */
.of-preview-flag {
  font: inherit;
  font-size: 11px;
  letter-spacing: .06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--mrd-border-subtle, #d8d8d5);
  color: var(--mrd-text-secondary, #6b6b68);
  white-space: nowrap;
}
.of-hidden { display: none !important; }
.of-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.of-col { display: flex; flex-direction: column; gap: 12px; }
.of-grow { flex: 1 1 auto; min-width: 0; }
.of-muted { color: var(--mrd-text-secondary, #6b6b68); }
.of-drawer {
  position: fixed; inset-block: 0; inset-inline-end: 0; width: min(420px, 92vw);
  background: var(--mrd-surface-raised, #fff);
  border-inline-start: 1px solid var(--mrd-border-subtle, #e2e2df);
  box-shadow: -18px 0 48px rgba(0,0,0,.12);
  z-index: 60; overflow-y: auto; padding: 20px;
  transform: translateX(100%); transition: transform .18s ease;
}
.of-drawer[data-open="true"] { transform: none; }
.of-scrim {
  position: fixed; inset: 0; background: rgba(20,20,19,.32);
  z-index: 55; opacity: 0; pointer-events: none; transition: opacity .18s ease;
}
.of-scrim[data-open="true"] { opacity: 1; pointer-events: auto; }
.of-palette {
  position: fixed; inset-block-start: 12vh; inset-inline: 0; margin-inline: auto;
  width: min(620px, 92vw); z-index: 70;
  background: var(--mrd-surface-raised, #fff);
  border: 1px solid var(--mrd-border-subtle, #e2e2df);
  border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.18); overflow: hidden;
}
.of-palette input { width: 100%; border: 0; border-block-end: 1px solid var(--mrd-border-subtle,#e2e2df); padding: 14px 16px; font: inherit; font-size: 15px; background: transparent; color: inherit; }
.of-palette input:focus { outline: none; }
.of-palette ul { list-style: none; margin: 0; padding: 6px; max-height: 46vh; overflow-y: auto; }
.of-palette li { padding: 9px 12px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; gap: 12px; }
.of-palette li[aria-selected="true"], .of-palette li:hover { background: var(--mrd-surface-sunken, #f2f2ef); }
.of-stage { display: flex; min-height: 0; flex: 1 1 auto; }
.of-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 24px clamp(16px, 4vw, 40px) 40px; }
.of-shell { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.of-top { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-block-end: 1px solid var(--mrd-border-subtle,#e2e2df); flex: 0 0 auto; }
.of-side { flex: 0 0 232px; border-inline-end: 1px solid var(--mrd-border-subtle,#e2e2df); overflow-y: auto; padding: 14px 10px; }
.of-nav-btn { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; font: inherit; color: inherit; text-align: start; padding: 8px 10px; border-radius: 9px; cursor: pointer; }
.of-nav-btn:hover { background: var(--mrd-surface-sunken,#f2f2ef); }
.of-nav-btn[aria-current="page"] { background: var(--mrd-surface-sunken,#eeeeea); font-weight: 600; }
.of-nav-title { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--mrd-text-secondary,#6b6b68); padding: 14px 10px 6px; }
.of-chip { border: 1px solid var(--mrd-border-subtle,#e2e2df); background: transparent; border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; color: inherit; }
.of-chip[aria-pressed="true"] { background: var(--mrd-text-primary,#141413); color: var(--mrd-surface-raised,#fff); border-color: var(--mrd-text-primary,#141413); }
.of-card { border: 1px solid var(--mrd-border-subtle,#e2e2df); border-radius: 12px; padding: 14px 16px; background: var(--mrd-surface-raised,#fff); }
.of-card--tap { cursor: pointer; }
.of-card--tap:hover { border-color: var(--mrd-border-strong,#c9c9c4); }
.of-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
.of-dot--healthy { background: #2f9e63; } .of-dot--degraded { background: #c98a1b; }
.of-dot--unknown { background: #a3a39e; } .of-dot--offline { background: #c0453b; }
.of-composer { border: 1px solid var(--mrd-border-strong,#d3d3ce); border-radius: 14px; padding: 12px 14px; background: var(--mrd-surface-raised,#fff); }
.of-composer textarea { width: 100%; border: 0; resize: none; font: inherit; font-size: 15px; background: transparent; color: inherit; min-height: 52px; }
.of-composer textarea:focus { outline: none; }
.of-stage-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.of-stage-list li { display: flex; gap: 10px; align-items: center; }
.of-h1 { font-size: 22px; font-weight: 620; letter-spacing: -.01em; margin: 0; }
.of-h2 { font-size: 15px; font-weight: 620; margin: 0; }
.of-sep { height: 1px; background: var(--mrd-border-subtle,#e2e2df); border: 0; margin: 4px 0; }
.of-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.of-table th { text-align: start; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--mrd-text-secondary,#6b6b68); padding: 8px 10px; border-block-end: 1px solid var(--mrd-border-subtle,#e2e2df); }
.of-table td { padding: 10px; border-block-end: 1px solid var(--mrd-border-subtle,#f0f0ed); }
.of-scroll-x { overflow-x: auto; }
.of-menu-btn { display: none; }

@media (max-width: 900px) {
  .of-menu-btn { display: inline-flex; }
  .of-side {
    position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 65; width: 264px;
    background: var(--mrd-surface-raised,#fff); transform: translateX(-100%);
    transition: transform .18s ease; flex-basis: auto;
  }
  .of-side[data-open="true"] { transform: none; }
  .of-main { padding: 16px; }
  /* A table at 390px is a horizontal scrollbar nobody finds. */
  .of-table, .of-table tbody, .of-table tr, .of-table td { display: block; width: 100%; }
  .of-table thead { display: none; }
  .of-table tr { border: 1px solid var(--mrd-border-subtle,#e2e2df); border-radius: 12px; padding: 10px; margin-block-end: 10px; }
  .of-table td { border: 0; padding: 3px 0; display: flex; justify-content: space-between; gap: 12px; }
  .of-table td::before { content: attr(data-label); color: var(--mrd-text-secondary,#6b6b68); font-size: 12px; }
  .of-drawer { width: 100vw; }
}
@media (prefers-reduced-motion: reduce) {
  .of-drawer, .of-scrim, .of-side { transition: none; }
}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.MERIDIAN_OFFLINE_DATA = ${JSON.stringify(DATA)};
window.MERIDIAN_VERSION = ${JSON.stringify(pkg.version)};
</script>
<script>
${readFileSync(join(ROOT, 'scripts/offline-ui-app.js'), 'utf8')}
</script>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'index.html'), html);

const bytes = Buffer.byteLength(html);
process.stdout.write(
  `  offline UI: ${(bytes / 1024).toFixed(0)} KB -> ${join(OUT_DIR, 'index.html')}\n` +
    `  production stylesheet inlined from ${cssFiles.join(', ')}\n`,
);
