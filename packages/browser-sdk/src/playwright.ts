import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { MeridianError } from '@meridian/shared';
import type { BrowserProvider, ProviderSession, ProviderSessionOptions } from './provider.js';
import type {
  BrowserEngineId,
  BrowserEngineInfo,
  ClickOptions,
  FillOptions,
  PageSnapshot,
  ScreenshotResult,
  SelectOptions,
  SnapshotElement,
  WaitOptions,
} from './types.js';

/** Caps that keep a page from flooding a model's context or the event log. */
const MAX_TEXT_CHARS = 20_000;
const MAX_OUTLINE_CHARS = 12_000;
const MAX_ELEMENTS = 150;
const MAX_EVAL_RESULT = 8_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface PlaywrightProviderOptions {
  engine: BrowserEngineId;
  /** Explicit Chromium binary; otherwise the standard install locations are scanned. */
  executablePath?: string | null;
  /**
   * CDP endpoint of an already-running browser to attach to instead of
   * launching. This is how Lightpanda is used: it serves CDP, and this provider
   * attaches — Meridian does not bundle or launch the binary itself.
   */
  cdpUrl?: string | null;
}

/**
 * The Playwright-backed provider.
 *
 * One class serves two engines because they meet at the same protocol: Chromium
 * is launched locally, Lightpanda is attached to over CDP. Playwright is the
 * driver either way, which keeps clicking, filling and snapshotting identical
 * across engines — the difference an operator chooses is startup weight and
 * compatibility, not capability surface.
 */
export class PlaywrightProvider implements BrowserProvider {
  readonly engine: BrowserEngineId;
  private readonly opts: PlaywrightProviderOptions;
  private browser: Browser | null = null;
  private lastError: string | null = null;

  constructor(opts: PlaywrightProviderOptions) {
    this.engine = opts.engine;
    this.opts = opts;
  }

  async info(): Promise<BrowserEngineInfo> {
    const notes: Record<BrowserEngineId, string> = {
      chromium: 'Full Chromium: maximum site compatibility, heavier startup.',
      lightpanda: 'Lightpanda over CDP: fast and light; not every site renders — Chromium is the fallback.',
      cdp: 'Your real browser over CDP (browser-harness style): sees your logged-in sessions; actions happen in your actual browser.',
    };
    const remedies: Record<BrowserEngineId, string> = {
      chromium: 'Install Chromium (npx playwright install chromium) or set MERIDIAN_CHROMIUM_PATH.',
      lightpanda: 'Set MERIDIAN_LIGHTPANDA_CDP to a running lightpanda CDP endpoint to enable this engine.',
      cdp: 'Start your browser with remote debugging (see browser-harness install.md) and set MERIDIAN_BROWSER_CDP_URL, e.g. http://127.0.0.1:9222.',
    };
    try {
      await this.ensureBrowser();
      return { id: this.engine, available: true, detail: null, note: notes[this.engine] };
    } catch (e) {
      return { id: this.engine, available: false, detail: e instanceof Error ? e.message : String(e), note: remedies[this.engine] };
    }
  }

  /**
   * Load Playwright on first use, not at import time.
   *
   * The gateway bundle keeps playwright-core external, and a deployment that
   * has no browser support at all should still start and report the engine as
   * unavailable — a missing optional dependency must never be a boot failure.
   */
  private async playwright(): Promise<typeof import('playwright-core')> {
    try {
      return await import('playwright-core');
    } catch (e) {
      throw new MeridianError(
        'unsupported_capability',
        `Playwright is not installed in this deployment, so browser sessions are unavailable (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const { chromium } = await this.playwright();
    if (this.engine === 'lightpanda' || this.engine === 'cdp') {
      if (!this.opts.cdpUrl) {
        const envVar = this.engine === 'lightpanda' ? 'MERIDIAN_LIGHTPANDA_CDP' : 'MERIDIAN_BROWSER_CDP_URL';
        throw new MeridianError('unsupported_capability', `No CDP endpoint is configured for the ${this.engine} engine (${envVar})`);
      }
      this.browser = await chromium.connectOverCDP(this.opts.cdpUrl, { timeout: 15_000 });
      return this.browser;
    }

    const executablePath = this.opts.executablePath ?? findChromium();
    if (!executablePath) {
      throw new MeridianError('unsupported_capability', 'No Chromium binary found. Install it with `npx playwright install chromium` or set MERIDIAN_CHROMIUM_PATH.');
    }
    this.browser = await chromium.launch({
      executablePath,
      // Sandboxless only where the process already runs as root in a container;
      // Chromium refuses its own sandbox there. Everywhere else the sandbox stays.
      args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
      timeout: 30_000,
    });
    return this.browser;
  }

  async createSession(opts: ProviderSessionOptions): Promise<ProviderSession> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: opts.viewport ?? DEFAULT_VIEWPORT,
      userAgent: opts.userAgent,
      storageState: opts.storageState ? (JSON.parse(opts.storageState) as never) : undefined,
      acceptDownloads: false,
    });

    // The domain policy is enforced where requests actually leave: a page's
    // subresources and redirects go through here too, not only the top-level
    // navigation the caller asked for.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (opts.requestFilter(url)) void route.continue();
      else {
        opts.onLog('network', `blocked by policy: ${url.slice(0, 200)}`);
        void route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();
    wireLogs(page, opts);
    return new PlaywrightSession(context, page, opts);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

function wireLogs(page: Page, opts: ProviderSessionOptions): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') opts.onLog('console', `console.error: ${msg.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => opts.onLog('error', `page error: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    // Aborted-by-policy is already logged as such; the rest is signal.
    if (!failure.includes('BLOCKED')) opts.onLog('network', `request failed: ${req.url().slice(0, 160)} (${failure})`);
  });
  page.on('download', (d) => {
    opts.onLog('lifecycle', `download refused by policy: ${d.suggestedFilename()}`);
    void d.cancel();
  });
}

class PlaywrightSession implements ProviderSession {
  private readonly context: BrowserContext;
  private readonly pages: Page[];
  private active = 0;
  private readonly opts: ProviderSessionOptions;

  constructor(context: BrowserContext, page: Page, opts: ProviderSessionOptions) {
    this.context = context;
    this.pages = [page];
    this.opts = opts;
  }

  private page(): Page {
    const p = this.pages[this.active];
    if (!p || p.isClosed()) throw new MeridianError('invalid_request', 'The active tab is closed');
    return p;
  }

  /** Playwright takes timeouts, not signals; the bridge converts. */
  private budget(signal: AbortSignal, dflt = 30_000): number {
    if (signal.aborted) throw new MeridianError('cancelled', 'Browser operation cancelled');
    return dflt;
  }

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    this.opts.onLog('lifecycle', `navigate ${url.slice(0, 200)}`);
    await this.page().goto(url, { timeout: this.budget(signal), waitUntil: 'domcontentloaded' });
  }

  async back(signal: AbortSignal): Promise<void> {
    await this.page().goBack({ timeout: this.budget(signal) });
  }

  async forward(signal: AbortSignal): Promise<void> {
    await this.page().goForward({ timeout: this.budget(signal) });
  }

  async reload(signal: AbortSignal): Promise<void> {
    await this.page().reload({ timeout: this.budget(signal) });
  }

  async currentUrl(): Promise<string | null> {
    try {
      return this.page().url() || null;
    } catch {
      return null;
    }
  }

  async title(): Promise<string | null> {
    try {
      return await this.page().title();
    } catch {
      return null;
    }
  }

  async snapshot(signal: AbortSignal): Promise<PageSnapshot> {
    this.budget(signal);
    const page = this.page();

    // One pass in the page's own world: tag every interactive element with a
    // stable ref and bring back just enough to identify it. Acting later uses
    // the tag as a selector, so a ref stays valid until the next snapshot even
    // though no element handles are held across the boundary. The script ships
    // as a string: a compiled function picks up bundler helpers (__name) that
    // do not exist inside the page.
    const raw = (await page.evaluate(`(${SNAPSHOT_SCRIPT})(${MAX_ELEMENTS})`)) as {
      elements: SnapshotElement[];
      text: string;
      outline: string;
      title: string;
      url: string;
    };

    const truncated = raw.text.length > MAX_TEXT_CHARS || raw.outline.length > MAX_OUTLINE_CHARS || raw.elements.length >= MAX_ELEMENTS;
    return {
      url: raw.url,
      title: raw.title,
      text: raw.text.slice(0, MAX_TEXT_CHARS),
      outline: raw.outline.slice(0, MAX_OUTLINE_CHARS),
      elements: raw.elements,
      truncated,
      capturedAt: Date.now(),
    };
  }

  async html(signal: AbortSignal, maxBytes: number): Promise<string> {
    this.budget(signal);
    const content = await this.page().content();
    return content.slice(0, maxBytes);
  }

  private byRef(ref: string): string {
    if (!/^e\d{1,4}$/.test(ref)) throw new MeridianError('invalid_request', `"${ref}" is not a snapshot ref (take a snapshot first; refs look like e12)`);
    return `[data-meridian-ref="${ref}"]`;
  }

  async click(opts: ClickOptions, signal: AbortSignal): Promise<void> {
    this.opts.onLog('lifecycle', `click ${opts.ref}`);
    try {
      await this.page().click(this.byRef(opts.ref), { timeout: this.budget(signal, 10_000) });
    } catch (e) {
      // Elements a page keeps off-viewport on purpose (skip links, items in
      // collapsed menus) fail Playwright's actionability wait forever. They
      // are still real targets, so fall back to a forced click once.
      if (signal.aborted || !(e instanceof Error) || !e.message.includes('outside of the viewport')) throw e;
      this.opts.onLog('lifecycle', `click ${opts.ref}: off-viewport, forcing`);
      await this.page().click(this.byRef(opts.ref), { timeout: 5_000, force: true });
    }
  }

  async fill(opts: FillOptions, signal: AbortSignal): Promise<void> {
    this.opts.onLog('lifecycle', `fill ${opts.ref} (${opts.text.length} chars)`);
    const selector = this.byRef(opts.ref);
    await this.page().fill(selector, opts.text, { timeout: this.budget(signal, 10_000) });
    if (opts.submit) await this.page().press(selector, 'Enter', { timeout: 5_000 });
  }

  async select(opts: SelectOptions, signal: AbortSignal): Promise<void> {
    await this.page().selectOption(this.byRef(opts.ref), opts.value, { timeout: this.budget(signal, 10_000) });
  }

  async hover(ref: string, signal: AbortSignal): Promise<void> {
    await this.page().hover(this.byRef(ref), { timeout: this.budget(signal, 10_000) });
  }

  async press(key: string, signal: AbortSignal): Promise<void> {
    if (!/^[\w+]{1,32}$/.test(key)) throw new MeridianError('invalid_request', `"${key}" is not a key name`);
    this.budget(signal);
    await this.page().keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void> {
    this.budget(signal);
    await this.page().evaluate((dir) => window.scrollBy(0, dir === 'down' ? window.innerHeight * 0.8 : -window.innerHeight * 0.8), direction);
  }

  async pointerMove(x: number, y: number, signal: AbortSignal): Promise<void> {
    this.budget(signal);
    await this.page().mouse.move(x, y);
  }

  async pointerClick(
    x: number,
    y: number,
    opts: { button?: 'left' | 'middle' | 'right'; clickCount?: number },
    signal: AbortSignal,
  ): Promise<void> {
    this.budget(signal);
    await this.page().mouse.click(x, y, { button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 });
  }

  async pointerDrag(from: { x: number; y: number }, to: { x: number; y: number }, signal: AbortSignal): Promise<void> {
    this.budget(signal);
    const mouse = this.page().mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    // Intermediate points: a press-then-teleport-then-release reads as a click
    // to anything that tracks movement.
    for (let i = 1; i <= 12; i++) {
      await mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    }
    await mouse.up();
  }

  async typeText(text: string, signal: AbortSignal): Promise<void> {
    this.budget(signal);
    await this.page().keyboard.type(text, { delay: 8 });
  }

  async wait(opts: WaitOptions, signal: AbortSignal): Promise<void> {
    const page = this.page();
    if (opts.forText) {
      await page.waitForFunction(
        (needle) => (document.body?.innerText ?? '').includes(needle),
        opts.forText,
        { timeout: this.budget(signal, 15_000) },
      );
      return;
    }
    if (opts.forNavigation) {
      await page.waitForLoadState('domcontentloaded', { timeout: this.budget(signal, 15_000) });
      return;
    }
    // A bare wait is bounded whatever the caller asked for.
    this.budget(signal);
    await page.waitForTimeout(Math.min(opts.ms ?? 500, 10_000));
  }

  async evaluate(expression: string, signal: AbortSignal): Promise<string> {
    this.budget(signal);
    const result = await this.page().evaluate((expr) => {
      // eslint-disable-next-line no-eval
      const value = (0, eval)(expr);
      try {
        return typeof value === 'string' ? value : JSON.stringify(value);
      } catch {
        return String(value);
      }
    }, expression);
    return String(result ?? '').slice(0, MAX_EVAL_RESULT);
  }

  async screenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    this.budget(signal);
    const page = this.page();
    const buf = await page.screenshot({ type: 'png', timeout: 15_000 });
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    return { data: buf.toString('base64'), width: viewport.width, height: viewport.height };
  }

  async storageState(): Promise<string> {
    return JSON.stringify(await this.context.storageState());
  }

  async listTabs(): Promise<{ index: number; url: string | null; title: string | null; active: boolean }[]> {
    const out: { index: number; url: string | null; title: string | null; active: boolean }[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      out.push({
        index: i,
        url: p.isClosed() ? null : p.url() || null,
        title: p.isClosed() ? null : await p.title().catch(() => null),
        active: i === this.active,
      });
    }
    return out;
  }

  async openTab(url: string | null, signal: AbortSignal): Promise<number> {
    const page = await this.context.newPage();
    wireLogs(page, this.opts);
    this.pages.push(page);
    this.active = this.pages.length - 1;
    if (url) await this.navigate(url, signal);
    return this.active;
  }

  async switchTab(index: number): Promise<void> {
    if (!this.pages[index] || this.pages[index].isClosed()) throw new MeridianError('invalid_request', `No tab ${index}`);
    this.active = index;
  }

  async closeTab(index: number): Promise<void> {
    const page = this.pages[index];
    if (!page) throw new MeridianError('invalid_request', `No tab ${index}`);
    await page.close();
    if (this.active >= index && this.active > 0) this.active -= 1;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

/** The standard Playwright install locations, newest build first. */
function findChromium(): string | null {
  if (process.env.MERIDIAN_CHROMIUM_PATH && existsSync(process.env.MERIDIAN_CHROMIUM_PATH)) return process.env.MERIDIAN_CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(process.env.HOME ?? '/root', '.cache/ms-playwright')].filter(
    (r): r is string => !!r,
  );
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith('chromium'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const candidate of [join(root, dir, 'chrome-linux', 'chrome'), join(root, dir, 'chrome-linux', 'headless_shell')]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * The snapshot pass, shipped verbatim into the page.
 *
 * Plain JavaScript in a string, not a compiled function: esbuild-family
 * runners inject `__name` helpers into transformed functions, and those
 * helpers do not exist in the page's world. A string cannot be transformed.
 */
const SNAPSHOT_SCRIPT = String.raw`function meridianSnapshot(maxElements) {
  var interactive = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], [contenteditable="true"], summary';
  var seen = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll(interactive));
  var n = 0;
  for (var i = 0; i < nodes.length; i++) {
    if (n >= maxElements) break;
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    n += 1;
    var ref = 'e' + n;
    el.setAttribute('data-meridian-ref', ref);
    var tag = el.tagName.toLowerCase();
    var roleMap = { a: 'link', button: 'button', input: el.type === 'submit' ? 'button' : 'textbox', select: 'combobox', textarea: 'textbox', summary: 'button' };
    var role = el.getAttribute('role') || roleMap[tag] || tag;
    var name =
      el.getAttribute('aria-label') ||
      ((tag === 'input' || tag === 'textarea') ? (el.placeholder || el.name || '') : '') ||
      String(el.innerText || el.value || '').trim().slice(0, 80);
    var entry = { ref: ref, role: role, name: name || '<' + tag + '>', enabled: !el.disabled };
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.type !== 'password' && el.value) {
      entry.value = String(el.value).slice(0, 120);
    }
    var href = el.getAttribute('href');
    if (href) entry.href = new URL(href, location.href).toString().slice(0, 300);
    seen.push(entry);
  }

  var text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');

  var outlineParts = [];
  function walk(node, depth) {
    if (depth > 5 || outlineParts.length > 400) return;
    var children = node.children;
    for (var c = 0; c < children.length; c++) {
      var child = children[c];
      var t = child.tagName.toLowerCase();
      if (/^(h1|h2|h3|h4|nav|main|form|table|section|article|aside|header|footer)$/.test(t)) {
        var label = String(child.innerText || '').trim().split('\n')[0].slice(0, 80);
        outlineParts.push(Array(depth + 1).join('  ') + t + (label ? ': ' + label : ''));
      }
      walk(child, /^(nav|main|section|article|form)$/.test(t) ? depth + 1 : depth);
    }
  }
  if (document.body) walk(document.body, 0);

  return { elements: seen, text: text, outline: outlineParts.join('\n'), title: document.title, url: location.href };
}`;
