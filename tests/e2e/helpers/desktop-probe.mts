/**
 * The real thing: a GUI application on a real X server, driven by X-level
 * synthetic input, verified by reading the application's own state.
 *
 * Nothing here goes through the browser's automation API for the *input* —
 * the keystrokes are XTest events delivered to whatever window has focus,
 * exactly as they would be on a user's desktop. Playwright is used only to
 * read the resulting DOM back, i.e. to ask the application what it received.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeComputerBackend } from '@meridian/computer-sdk';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

const DISPLAY = ':99';
const dir = mkdtempSync(join(tmpdir(), 'meridian-desktop-'));
const page = join(dir, 'app.html');
writeFileSync(
  page,
  `<!doctype html><html><body style="margin:0;font:16px sans-serif">
   <h1>Meridian desktop test</h1>
   <textarea id="t" autofocus style="width:90vw;height:200px;font-size:20px"></textarea>
   </body></html>`,
);

// Launch a real GUI application onto the X display, with remote debugging so we
// can later ask it what it received.
const proc = spawn(
  '/usr/local/bin/chromium',
  [
    '--no-sandbox',
    '--no-first-run',
    '--disable-gpu',
    '--remote-debugging-port=9333',
    `--user-data-dir=${join(dir, 'profile')}`,
    '--window-size=1280,800',
    '--window-position=0,0',
    `file://${page}`,
  ],
  { env: { ...process.env, DISPLAY }, stdio: 'ignore', detached: true },
);

const backend = new NativeComputerBackend({ display: DISPLAY, python: '/tmp/mscreen/bin/python' });
const c = new AbortController();

try {
  // Wait for the application's window to appear on the display.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(800) });
      up = res.ok;
    } catch {
      /* not yet */
    }
  }
  assert(up, 'a real GUI application started on the X display');
  await new Promise((r) => setTimeout(r, 1500));

  await backend.open();

  const before = await backend.screenshot(c.signal);
  assert(before.width === 1280, `screen captured with the app on it (${before.width}x${before.height})`);

  // Click into the textarea using X-level synthetic input, then type.
  await backend.execute({ type: 'click', to: { x: 640, y: 300 } }, c.signal);
  await new Promise((r) => setTimeout(r, 300));

  const PHRASE = 'Meridian computer agent test';
  await backend.execute({ type: 'type', text: PHRASE }, c.signal);
  await new Promise((r) => setTimeout(r, 800));

  // Ask the application what it actually received.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const target = pages.find((p) => p.url().startsWith('file://')) ?? pages[0];
  const value = (await target.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement | null)?.value ?? '')) as string;
  console.log('textarea now contains:', JSON.stringify(value));
  assert(value === PHRASE, 'X-level keystrokes landed in the real application');

  // The screen must visibly differ now that the text is on it. Compared here,
  // while the text is present — comparing after clearing would restore the
  // original appearance and prove nothing.
  const typed = await backend.screenshot(c.signal);
  assert(typed.data !== before.data, 'the screen visibly changed once the text was typed');

  // Keyboard shortcut: select all, then delete — proves modifiers work.
  await backend.execute({ type: 'hotkey', keys: ['ctrl', 'a'] }, c.signal);
  await new Promise((r) => setTimeout(r, 200));
  await backend.execute({ type: 'key_press', key: 'BackSpace' }, c.signal);
  await new Promise((r) => setTimeout(r, 400));
  const cleared = (await target.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement | null)?.value ?? '')) as string;
  assert(cleared === '', 'ctrl+a then BackSpace cleared the field (modifier keys work)');

  await browser.close().catch(() => undefined);
  console.log('\nDESKTOP E2E PASSED — real app, real X input, verified by the app itself');
} finally {
  await backend.close();
  try {
    process.kill(-proc.pid!, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
process.exit(0);
