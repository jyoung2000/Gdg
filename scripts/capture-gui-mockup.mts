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
  { id: 'projects', label: 'Projects' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'agents', label: 'Agents' },
  { id: 'browser', label: 'Browser' },
  { id: 'computer', label: 'Computer' },
  { id: 'versioncontrol', label: 'Version Control', nav: 'Version Control' },
  { id: 'generations', label: 'Generations' },
  { id: 'discover', label: 'Discover' },
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
  // 'load', not 'networkidle': the app holds an open SSE event stream, so the
  // network never goes idle and networkidle would hang until timeout.
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(700);
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

// The mockup navigates through the app's own sidebar — the real menu — so a
// label like "Version Control" resolves to the screen id it opens.
const labelToId = JSON.stringify(
  Object.fromEntries(captured.map((s) => [(SCREENS.find((x) => x.id === s.id)?.nav ?? s.label).toLowerCase(), s.id])),
);

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
  buttons, inputs and links are inert, EXCEPT the app's own left sidebar, which
  is wired to switch between the captured screens so you can navigate exactly as
  in the real app. There is no second, added menu. To change how the GUI looks,
  edit the CSS in the first <style> block or the markup inside each <section>.
  Regenerate from the live app with scripts/capture-gui-mockup.mts.
-->
<style>
/* ---- Meridian's own compiled stylesheet, inlined verbatim ---- */
${css}
</style>
<style>
/* ---- Mockup framing only: one screen fills the viewport at a time. ---- */
.mock-screen { display: block; height: 100vh; overflow: hidden; }
.mock-screen[hidden] { display: none; }
.mock-screen > #root { height: 100%; }
</style>
</head>
<body>
${sections}
<script>
/* The only script in the file: let the app's own sidebar switch screens, so
   the mockup navigates through the real menu and shows no second one. */
(function () {
  var LABELS = ${labelToId};
  var screens = document.querySelectorAll('.mock-screen');
  function show(id) {
    if (!id) return;
    screens.forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== id; });
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function labelOf(el) {
    var t = (el.getAttribute('title') || el.textContent || '').trim().toLowerCase();
    return t.replace(/\\s+/g, ' ');
  }
  // Every captured screen carries its own sidebar; wire them all so a click in
  // whichever screen is visible moves to the next.
  document.querySelectorAll('.mrd-sidebar-item').forEach(function (item) {
    item.addEventListener('click', function (e) {
      var id = LABELS[labelOf(item)];
      if (id) { e.preventDefault(); e.stopPropagation(); show(id); }
    });
  });
})();
</script>
</body>
</html>
`;

writeFileSync(join(process.cwd(), outPath), doc, 'utf8');
process.stderr.write(`\nwrote ${outPath} (${Math.round(doc.length / 1024)} KB, ${captured.length} screens)\n`);
