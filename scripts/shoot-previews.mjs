/**
 * Screenshot a handful of screens from the local 1:1 mockup, from file://.
 *
 * These previews let the look be reviewed without opening a browser. They are
 * captured from the same self-contained mockup the app produces, so they move
 * whenever the mockup is regenerated. Run after regenerating the mockup:
 *   node scripts/shoot-previews.mjs
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pkg from 'playwright-core';
const { chromium } = pkg;

const root = process.cwd();
const mockup = join(root, 'docs/mockup/meridian-gui-mockup.html');
const TARGETS = ['chat', 'projects', 'computer', 'models', 'settings'];

function chromiumPath() {
  for (const c of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/local/bin/chromium',
  ]) {
    if (existsSync(c)) return c;
  }
  throw new Error('no chromium found');
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(mockup).href, { waitUntil: 'load' });
await page.waitForTimeout(300);

for (const id of TARGETS) {
  // The mockup toggles [hidden] on each <section data-screen>; drive it directly.
  await page.evaluate((screen) => {
    document.querySelectorAll('.mock-screen').forEach((s) => {
      s.hidden = s.getAttribute('data-screen') !== screen;
    });
    window.scrollTo(0, 0);
  }, id);
  await page.waitForTimeout(250);
  const out = join(root, `docs/mockup/preview-${id}.png`);
  await page.screenshot({ path: out });
  process.stderr.write(`shot ${id} -> ${out}\n`);
}

await browser.close();
process.stderr.write('done\n');
