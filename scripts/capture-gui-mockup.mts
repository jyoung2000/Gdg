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
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
// @ts-expect-error — plain ESM helper shared with the other generator.
import { uiFingerprint, fingerprintComment } from './ui-fingerprint.mjs';

const base = process.argv[2] ?? 'http://localhost:4655';
const outPath = process.argv[4] ?? 'docs/mockup/meridian-gui-mockup.html';

/**
 * Find the compiled stylesheet rather than being told where it is.
 *
 * The default was a literal content hash — `index-CPbt0mMy.css` — which stops
 * existing the first time anyone changes a token. A generator that silently
 * embeds the wrong stylesheet, or dies on a filename, is a generator nobody
 * runs, and an offline artefact nobody regenerates is one that quietly stops
 * matching the app.
 */
function findStylesheet(explicit?: string): string {
  if (explicit) return explicit;
  const dir = 'dist/web/assets';
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')) : [];
  if (found.length === 0) {
    throw new Error(`no stylesheet in ${dir} — run \`pnpm build\` first`);
  }
  return join(dir, found[0]);
}

const cssPath = findStylesheet(process.argv[3]);

/** Every screen in the shell, with the visible nav label where it differs. */
const SCREENS: { id: string; label: string; nav?: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'chat', label: 'Chat', nav: 'Chats' },
  { id: 'projects', label: 'Projects' },
  { id: 'director', label: 'Director' },
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
  { id: 'providers', label: 'Providers', nav: 'Connections' },
  { id: 'pools', label: 'Pools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'devops', label: 'DevOps' },
  { id: 'usage', label: 'Usage', nav: 'Activity' },
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
const failures: string[] = [];

for (const screen of SCREENS) {
  // 'load', not 'networkidle': the app holds an open SSE event stream, so the
  // network never goes idle and networkidle would hang until timeout.
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const toggle = page.locator('.app__nav-toggle');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();

  // Sixteen of the twenty-one screens now live behind the "More" disclosure, so
  // open it before looking for a label — and leave it open, because every
  // captured screen carries its own copy of the sidebar and the mockup is
  // navigated through those. Capturing a collapsed sidebar would produce a
  // mockup you could enter and not leave.
  const more = page.getByRole('button', { name: /^(Everything else|Hide advanced)$/i }).first();
  if (await more.isVisible().catch(() => false)) {
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
    await page.waitForTimeout(200);
  }

  const name = screen.nav ?? screen.label;
  try {
    await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first().click({ timeout: 8000 });
  } catch {
    // Loud, and fatal below: a mockup missing a screen is worse than no mockup,
    // because it looks complete.
    process.stderr.write(`! could not navigate to ${screen.id} (looked for "${name}")\n`);
    failures.push(screen.id);
  }
  await page.waitForTimeout(700);

  // Re-open the disclosure after navigating: landing on a primary screen
  // collapses it again, and the captured sidebar has to stay complete.
  const more2 = page.getByRole('button', { name: /^Everything else$/i }).first();
  if (await more2.isVisible().catch(() => false)) {
    await more2.click();
    await page.waitForTimeout(200);
  }
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
    (s) =>
      // Chat is what the app itself opens on, so it is what the mockup opens on.
      // Chosen by id rather than by array index, which silently pointed at a
      // different screen every time the list was reordered.
      `<section class="mock-screen" data-screen="${s.id}"${s.id === 'chat' ? '' : ' hidden'}>\n<div id="root">${s.html}</div>\n</section>`,
  )
  .join('\n');

// The mockup navigates through the app's own sidebar — the real menu — so a
// label like "Version Control" resolves to the screen id it opens.
const labelToId = JSON.stringify(
  Object.fromEntries(captured.map((s) => [(SCREENS.find((x) => x.id === s.id)?.nav ?? s.label).toLowerCase(), s.id])),
);

const fingerprint = uiFingerprint(process.cwd());

const doc = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
${fingerprintComment(fingerprint)}
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

if (failures.length) {
  process.stderr.write(
    `\nrefusing to write ${outPath}: could not reach ${failures.length} screen(s) — ${failures.join(', ')}\n` +
      'A mockup that is missing screens looks complete and is not, which is the one failure mode worth being loud about.\n',
  );
  process.exit(1);
}

writeFileSync(join(process.cwd(), outPath), doc, 'utf8');
process.stderr.write(
  `\nwrote ${outPath} (${Math.round(doc.length / 1024)} KB, ${captured.length} screens, ui ${fingerprint.hash})\n`,
);
