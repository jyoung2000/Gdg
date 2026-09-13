import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
// @ts-expect-error — plain ESM helper shared with the generators.
import { readNav } from '../../scripts/nav-manifest.mjs';

/**
 * The offline edition, opened the way a person opens it.
 *
 * The fingerprint gate proves the file was regenerated from the current UI
 * source. It cannot prove the file still *matches* the product, because the
 * offline sidebar used to be a second hand-written list that nothing compared
 * to anything — a page whose whole purpose is to look like the application was
 * the one place nothing checked.
 *
 * The generator now injects the application's own `NAV`. This opens the
 * artefact from `file://`, with no server and no network, and walks every
 * destination in it.
 */

const ARTEFACT = resolve(process.cwd(), 'offline-ui/index.html');

function chromiumPath(): string | null {
  for (const candidate of [
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe('The offline edition, in a browser', async () => {
  const executablePath = chromiumPath();
  const skip = !executablePath
    ? 'no Chromium in /opt/pw-browsers — a silently skipped UI test reads exactly like a passing one'
    : !existsSync(ARTEFACT)
      ? 'offline-ui/index.html has not been generated — run `pnpm build:offline-ui`'
      : false;
  if (skip) process.stderr.write(`\n  skipping: ${skip}\n`);

  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  before(async () => {
    if (skip) return;
    browser = await chromium.launch({ executablePath: executablePath!, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    // No server, no network: exactly how it is meant to be opened.
    await page.goto(pathToFileURL(ARTEFACT).href, { waitUntil: 'load' });
    await page.waitForTimeout(400);
  });

  after(async () => {
    await browser?.close();
  });

  it('carries the application’s own navigation, not a copy of it', { skip: skip || false }, async () => {
    const injected = await page.evaluate(
      () => (window as unknown as { __MERIDIAN_NAV__?: { id: string; label: string; section: string }[] }).__MERIDIAN_NAV__ ?? [],
    );
    assert.deepEqual(
      injected,
      readNav(process.cwd()),
      'the offline sidebar has drifted from apps/web/src/shell/App.tsx — regenerate with `pnpm build:offline-ui`',
    );
  });

  it('opens every destination it offers', { skip: skip || false }, async () => {
    const nav = readNav(process.cwd()) as { id: string; label: string; section: string }[];
    const thin: string[] = [];

    for (const entry of nav) {
      // Advanced destinations live behind the disclosure, exactly as in the app.
      if (entry.section === 'more') {
        const more = page.getByRole('button', { name: /Everything else/ }).first();
        if (await more.isVisible().catch(() => false)) {
          await more.click();
          await page.waitForTimeout(120);
        }
      }
      const button = page.getByRole('button', { name: new RegExp(`^${entry.label}$`) }).first();
      assert.ok(
        await button.isVisible().catch(() => false),
        `the offline sidebar offers no way to reach "${entry.label}"`,
      );
      await button.click();
      await page.waitForTimeout(120);

      // A screen that renders nothing is a link to a blank page, which is worse
      // than no link: it reads as a feature that exists and does not work.
      const length = await page.$eval('#root', (el) => el.textContent?.length ?? 0);
      if (length < 200) thin.push(`${entry.label} (${length} characters)`);
    }

    assert.deepEqual(thin, [], `these offline screens render almost nothing: ${thin.join(', ')}`);
  });

  it('reaches the network for nothing and logs no error', { skip: skip || false }, async () => {
    assert.deepEqual(errors, [], `the offline edition logged errors: ${errors.slice(0, 3).join(' | ')}`);
  });
});
