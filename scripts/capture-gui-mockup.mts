/**
 * Capture a 1:1 static mockup of the Meridian web client.
 *
 * The point of "1:1" is that nothing here is redrawn by hand: a real browser
 * loads the real built client against a real gateway, and each screen's actual
 * rendered DOM is captured along with the exact compiled stylesheet. The output
 * is a single self-contained HTML file that looks identical to the app and can
 * be opened from disk and edited with nothing installed.
 *
 * Run: npx tsx scripts/capture-gui-mockup.mts <baseUrl> <cssPath> <outPath>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:4655';
const cssPath = process.argv[3] ?? 'dist/web/assets/index-CPbt0mMy.css';
const outPath = process.argv[4] ?? 'docs/mockup/meridian-gui-mockup.html';

/** Every screen in the shell, with the visible nav label where it differs. */
const SCREENS: { id: string; label: string; nav?: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'chat', label: 'Chat' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'agents', label: 'Agents' },
  { id: 'browser', label: 'Browser' },
  { id: 'computer', label: 'Computer' },
  { id: 'versioncontrol', label: 'Version Control', nav: 'Version Control' },
  { id: 'generations', label: 'Generations' },
  { id: 'ai', label: 'AI' },
  { id: 'skills', label: 'Skills' },
  { id: 'models', label: 'Models' },
  { id: 'providers', label: 'Providers' },
  { id: 'pools', label: 'Pools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'devops', label: 'DevOps' },
  { id: 'usage', label: 'Usage' },
  { id: 'settings', label: 'Settings' },
];

function chromiumPath(): string {
  for (const c of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/local/bin/chromium',
  ]) {
    if (existsSync(c)) return c;
  }
  throw new Error('no chromium found');
}

const css = readFileSync(join(process.cwd(), cssPath), 'utf8');

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const captured: { id: string; label: string; html: string }[] = [];

for (const screen of SCREENS) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  if (screen.id !== 'home') {
    const toggle = page.locator('.app__nav-toggle');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const name = screen.nav ?? screen.label;
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first().click({ timeout: 8000 });
    } catch {
      process.stderr.write(`! could not navigate to ${screen.id}\n`);
    }
  }
  await page.waitForTimeout(700);
  // The whole shell, so the sidebar, status bar and inspector are all real.
  const html = await page.evaluate(() => {
    const root = document.getElementById('root');
    return root ? root.innerHTML : document.body.innerHTML;
  });
  captured.push({ id: screen.id, label: screen.label, html });
  process.stderr.write(`captured ${screen.id} (${html.length} bytes)\n`);
}

await browser.close();

const theme = 'dark';
const sections = captured
  .map(
    (s, i) =>
      `<section class="mock-screen" data-screen="${s.id}"${i === 2 ? '' : ' hidden'}>\n<div id="root">${s.html}</div>\n</section>`,
  )
  .join('\n');

const switcher = captured
  .map((s, i) => `<button class="mock-tab${i === 2 ? ' is-active' : ''}" data-target="${s.id}">${s.label}</button>`)
  .join('');

const doc = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Meridian GUI — 1:1 local mockup</title>
<!--
  This is a STATIC, LOCAL mockup of the Meridian web client, for looking at and
  editing the interface offline. It was captured from the real running client:
  the markup below is each screen's actual rendered DOM and the stylesheet is
  the app's own compiled CSS, inlined verbatim. Nothing here talks to a server —
  buttons, inputs and links are inert. To change how the GUI looks, edit the
  CSS in the first <style> block or the markup inside each <section>.
  Regenerate from the live app with scripts/capture-gui-mockup.mts.
-->
<style>
/* ---- Meridian's own compiled stylesheet, inlined verbatim ---- */
${css}
</style>
<style>
/* ---- Mockup chrome only: the banner and the screen switcher ---- */
.mock-bar { position: sticky; top: 0; z-index: 99999; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 12px; background: #10131a; color: #e7ecf3; border-bottom: 1px solid rgba(255,255,255,.12);
  font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.mock-bar strong { font-weight: 650; letter-spacing: .01em; }
.mock-bar .mock-note { opacity: .6; }
.mock-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.mock-tab { appearance: none; border: 1px solid rgba(255,255,255,.16); background: transparent; color: inherit;
  padding: 3px 9px; border-radius: 999px; font: inherit; cursor: pointer; }
.mock-tab:hover { background: rgba(255,255,255,.08); }
.mock-tab.is-active { background: #3d6dff; border-color: #3d6dff; color: #fff; }
.mock-screen { display: block; }
.mock-screen[hidden] { display: none; }
/* The captured app sets height on #root; give the viewport its own frame. */
.mock-viewport { height: calc(100vh - 42px); overflow: hidden; }
.mock-viewport > .mock-screen, .mock-viewport > .mock-screen > #root { height: 100%; }
</style>
</head>
<body>
<div class="mock-bar">
  <strong>Meridian GUI</strong>
  <span class="mock-note">1:1 static mockup · real DOM + real CSS · offline &amp; inert · edit freely</span>
  <nav class="mock-tabs">${switcher}</nav>
</div>
<div class="mock-viewport">
${sections}
</div>
<script>
/* The only script in the file: a plain screen switcher, no framework. */
(function () {
  var tabs = document.querySelectorAll('.mock-tab');
  var screens = document.querySelectorAll('.mock-screen');
  function show(id) {
    screens.forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== id; });
    tabs.forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-target') === id); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.getAttribute('data-target')); }); });
})();
</script>
</body>
</html>
`;

writeFileSync(join(process.cwd(), outPath), doc, 'utf8');
process.stderr.write(`\nwrote ${outPath} (${Math.round(doc.length / 1024)} KB, ${captured.length} screens)\n`);
