/**
 * Screenshot a handful of screens, so the look can be reviewed without a browser.
 *
 * Taken from the **running application** when a gateway URL is given, and from
 * the offline mockup otherwise. The difference matters more than it sounds: the
 * mockup deliberately leaves the "More" disclosure open so that every captured
 * screen carries a complete sidebar and the file can be navigated. That is
 * right for the mockup and wrong for a picture of the product — a preview shot
 * from it shows all twenty-one destinations at once, which is exactly the
 * interface the simplification removed.
 *
 *   node scripts/shoot-previews.mjs http://127.0.0.1:4639   from the live app
 *   node scripts/shoot-previews.mjs                          from the mockup
 *
 * `pnpm mockup` runs the first form with a throwaway gateway of its own.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pkg from 'playwright-core';
const { chromium } = pkg;

const root = process.cwd();
const base = process.argv[2] ?? null;
const mockup = join(root, 'docs/mockup/meridian-gui-mockup.html');

/** id → the sidebar label that opens it, where the two differ. */
const TARGETS = [
  { id: 'chat', nav: 'Chats' },
  { id: 'projects', nav: 'Projects' },
  { id: 'director', nav: 'Director' },
  { id: 'discover', nav: 'Discover' },
  { id: 'computer', nav: 'Computer' },
  { id: 'models', nav: 'Models' },
  { id: 'settings', nav: 'Settings' },
];

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

if (base) {
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(700);
} else {
  await page.goto(pathToFileURL(mockup).href, { waitUntil: 'load' });
  await page.waitForTimeout(300);
}

const failures = [];

for (const target of TARGETS) {
  if (base) {
    // Reach for the destination first, and only open the "More" disclosure if
    // it is not already on screen. Opening it unconditionally would put all
    // twenty-one items in every picture — including the four that are meant to
    // show a five-item sidebar — and the preview would contradict the change
    // it exists to illustrate. Whatever state the app is left in after
    // navigating is the state that gets photographed, because that is the
    // state a user would be looking at.
    const link = page.getByRole('button', { name: new RegExp(`^${target.nav}$`, 'i') }).first();
    if (!(await link.isVisible().catch(() => false))) {
      const more = page.getByRole('button', { name: /^(Everything else|Hide advanced)$/i }).first();
      if (await more.isVisible().catch(() => false)) {
        await more.click();
        await page.waitForTimeout(150);
      }
    }
    try {
      await page.getByRole('button', { name: new RegExp(`^${target.nav}$`, 'i') }).first().click({ timeout: 8000 });
    } catch {
      process.stderr.write(`! could not open ${target.id} (looked for "${target.nav}")\n`);
      failures.push(target.id);
      continue;
    }
    await page.waitForTimeout(600);
  } else {
    // The mockup toggles [hidden] on each <section data-screen>; drive it directly.
    await page.evaluate((screen) => {
      document.querySelectorAll('.mock-screen').forEach((s) => {
        s.hidden = s.getAttribute('data-screen') !== screen;
      });
      window.scrollTo(0, 0);
    }, target.id);
    await page.waitForTimeout(250);
  }

  const out = join(root, `docs/mockup/preview-${target.id}.png`);
  await page.screenshot({ path: out });
  process.stderr.write(`shot ${target.id} -> ${out}\n`);
}

await browser.close();

// A half-written preview set is worse than none: it looks complete.
if (failures.length) {
  process.stderr.write(`\n${failures.length} preview(s) could not be shot: ${failures.join(', ')}\n`);
  process.exit(1);
}
process.stderr.write('done\n');
