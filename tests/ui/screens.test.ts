import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright-core';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from '../e2e/helpers/sim-server.js';

/**
 * The web client, in a real browser, against a real gateway.
 *
 * A React app that compiles is not a React app that runs: a screen can throw on
 * first paint, a Content-Security-Policy can block the bundle it was written
 * for, and a layout can overflow on a phone without anything failing to build.
 * None of that is visible to a type checker, so each screen is opened here and
 * asked three questions — did it render, did it log an error, and does it fit.
 *
 * Requires Chromium. The suite skips, with the reason printed, when it is
 * absent: a silently skipped UI test reads exactly like a passing one.
 */

/**
 * Every screen in the shell's router.
 *
 * Kept exhaustive on purpose: a screen missing from this list is a screen
 * nobody ever opens in a browser, and the first person to find out it throws on
 * first paint should not be a user.
 */
const SCREENS = [
  'home', 'workspace', 'chat', 'tasks', 'agents', 'browser', 'computer',
  'versioncontrol', 'generations', 'ai', 'skills', 'models', 'providers',
  'pools', 'mcp', 'devops', 'usage', 'settings',
] as const;

/**
 * Nav labels that are not simply the screen id.
 *
 * The sidebar is written for people, so a couple of screens read differently
 * from the route that reaches them; the test navigates the way a user does, so
 * it has to know the visible name.
 */
const NAV_LABEL: Partial<Record<(typeof SCREENS)[number], string>> = {
  versioncontrol: 'Version Control',
};

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
];

function chromiumPath(): string | null {
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    for (const candidate of [
      join(root, 'chromium/chrome-linux/chrome'),
      join(root, 'chromium-1194/chrome-linux/chrome'),
      join(root, 'chromium_headless_shell-1194/chrome-linux/headless_shell'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

describe('Web client', async () => {
  const executablePath = chromiumPath();
  const webRoot = resolve(process.cwd(), 'dist/web');
  const skip = !executablePath
    ? 'Chromium is not installed'
    : !existsSync(join(webRoot, 'index.html'))
      ? 'the web client is not built — run `pnpm build` first'
      : false;

  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let browser: Browser;
  let dataDir: string;
  let shotDir: string;
  let base: string;

  before(async () => {
    if (skip) return;
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-ui-'));
    shotDir = resolve(process.cwd(), 'docs/evidence/screens');
    mkdirSync(shotDir, { recursive: true });
    sim = await startSimServer();

    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'ui.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_WEB_ROOT: webRoot,
      MERIDIAN_MASTER_KEY: 'ui-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    browser = await chromium.launch({ executablePath: executablePath!, args: ['--no-sandbox'] });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    await app?.stop();
    await sim?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /** Open the app and switch to a screen through its own navigation. */
  async function open(page: Page, screen: string): Promise<string[]> {
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(base, { waitUntil: 'networkidle' });
    if (screen !== 'home') {
      // Through the real navigation rather than a URL, because that is the path
      // a user takes and the one that can leave a screen half-mounted.
      const toggle = page.locator('.app__nav-toggle');
      if (await toggle.isVisible().catch(() => false)) await toggle.click();
      const label = NAV_LABEL[screen as (typeof SCREENS)[number]] ?? screen;
      await page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first().click();
    }
    await page.waitForTimeout(400);
    return errors;
  }

  it('boots without a console error and applies its own policy', { skip: skip || false }, async () => {
    const page = await browser.newPage({ viewport: VIEWPORTS[2] });
    try {
      const errors = await open(page, 'home');
      // A CSP that blocks the bundle shows up here and nowhere else.
      assert.deepEqual(errors, [], `the shell logged errors on first paint:\n${errors.join('\n')}`);
      const title = await page.title();
      assert.match(title, /Meridian/i);
      // The theme script runs inline and is allowed by hash, so a working page
      // has a resolved colour scheme rather than an unstyled flash.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'the body must have a painted background, not the host default');
    } finally {
      await page.close();
    }
  });

  for (const screen of SCREENS) {
    it(`renders the ${screen} screen`, { skip: skip || false }, async () => {
      const page = await browser.newPage({ viewport: VIEWPORTS[2] });
      try {
        const errors = await open(page, screen);
        assert.deepEqual(errors, [], `${screen} logged errors:\n${errors.join('\n')}`);

        // Something has to have rendered: a screen that throws during mount
        // leaves an empty main region rather than failing loudly.
        const text = (await page.locator('main, .app__main, body').first().innerText()).trim();
        assert.ok(text.length > 20, `${screen} rendered almost nothing: "${text.slice(0, 80)}"`);

        await page.screenshot({ path: join(shotDir, `${screen}.png`), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }

  for (const viewport of VIEWPORTS) {
    it(`fits a ${viewport.name} viewport without sideways scrolling`, { skip: skip || false }, async () => {
      const page = await browser.newPage({ viewport });
      try {
        const overflowing: string[] = [];
        for (const screen of SCREENS) {
          await open(page, screen);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 1) overflowing.push(`${screen} (+${overflow}px)`);
        }
        assert.deepEqual(overflowing, [], `these screens overflow horizontally: ${overflowing.join(', ')}`);
        await page.screenshot({ path: join(shotDir, `viewport-${viewport.name}.png`), fullPage: false });
      } finally {
        await page.close();
      }
    });
  }

  it('renders in both themes without losing its colours', { skip: skip || false }, async () => {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: VIEWPORTS[2], colorScheme: theme as 'light' | 'dark' });
      try {
        await open(page, 'home');
        const { bg, fg } = await page.evaluate(() => {
          const style = getComputedStyle(document.body);
          return { bg: style.backgroundColor, fg: style.color };
        });
        assert.notEqual(bg, 'rgba(0, 0, 0, 0)', `${theme}: the body has no background`);
        assert.notEqual(bg, fg, `${theme}: text and background resolved to the same colour`);
        await page.screenshot({ path: join(shotDir, `theme-${theme}.png`), fullPage: false });
      } finally {
        await page.close();
      }
    }
  });

  it('states the sandbox posture in full rather than truncating the warning', { skip: skip || false }, async () => {
    const page = await browser.newPage({ viewport: VIEWPORTS[2] });
    try {
      await open(page, 'home');
      const body = await page.locator('body').innerText();
      // This instance runs the process sandbox, which is not isolation. The
      // card is narrow, and a truncated note would drop exactly that clause.
      assert.match(body, /Not a security boundary/i, `the home screen must say what the process sandbox is not:\n${body.slice(0, 500)}`);
      assert.ok(!/,\s*$|\.\.\.$/m.test(body.split('\n').find((l) => /security boundary/i.test(l)) ?? ''), 'the warning must be a complete sentence');
    } finally {
      await page.close();
    }
  });

  it('shows live data from the gateway rather than an empty shell', { skip: skip || false }, async () => {
    const page = await browser.newPage({ viewport: VIEWPORTS[2] });
    try {
      await open(page, 'models');
      // The discovered local model has to appear, which means the client
      // fetched, parsed and rendered real data from this gateway.
      await page.waitForSelector('text=meridian-sim-chat', { timeout: 15_000 });
      const body = await page.locator('body').innerText();
      assert.match(body, /meridian-sim-chat/);
    } finally {
      await page.close();
    }
  });
});
