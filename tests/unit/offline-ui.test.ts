import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PAGE = join(ROOT, 'offline-ui/index.html');
const hasPage = existsSync(PAGE);

/**
 * The offline edition, checked for the one property it exists to have.
 *
 * "Self-contained" is easy to believe and easy to break: one `<script src>`, one
 * webfont, one `url(/assets/…)` left in the stylesheet, and a file that opens
 * perfectly on the machine that built it shows an unstyled page on a laptop
 * with no network — which is exactly the situation it was made for.
 *
 * So this reads the shipped bytes rather than trusting the generator.
 */
describe('The offline edition', { skip: !hasPage ? 'not generated; run pnpm build:offline-ui' : false }, () => {
  const html = hasPage ? readFileSync(PAGE, 'utf8') : '';

  /**
   * Comments do not fetch anything.
   *
   * The bundled stylesheet carries MIT licence notices, and those notices cite
   * URLs — which is the attribution the licence requires and must not be
   * stripped. A check that flagged them would push someone toward deleting a
   * copyright notice to make a test green, so it looks at what a browser would
   * actually request instead.
   */
  const fetchable = html.replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('reaches nothing outside itself', () => {
    // Every way a page can pull in a byte from somewhere else.
    const external = [
      [/<script[^>]+\bsrc\s*=/i, 'an external <script src>'],
      [/<link[^>]+\brel\s*=\s*["']?stylesheet/i, 'an external stylesheet <link>'],
      [/<img[^>]+\bsrc\s*=\s*["'](?!data:)/i, 'an <img> with a non-data source'],
      [/@import\s+(?!url\(["']?data:)/i, 'a CSS @import'],
      [/url\((?!['"]?data:)[^)]*\)/i, 'a CSS url() that is not a data: URI'],
      [/\b(?:src|href)\s*=\s*["']https?:/i, 'an element pointing at an absolute URL'],
      [/\bfetch\s*\(|XMLHttpRequest|EventSource|new WebSocket/i, 'code that opens a network connection'],
    ] as const;
    for (const [pattern, what] of external) {
      const found = pattern.exec(fetchable);
      assert.equal(found, null, `the offline page contains ${what}: ${found?.[0]?.slice(0, 120)}`);
    }
  });

  it('carries the production stylesheet rather than a lookalike', () => {
    // The point of inlining the real CSS is that the offline edition cannot
    // drift into being a second design system. If these class definitions are
    // absent, something has started maintaining a copy by hand.
    for (const cls of ['.mrd-button', '.mrd-badge', '.mrd-card', '.mrd-sidebar-item']) {
      assert.ok(html.includes(cls), `the production stylesheet is missing ${cls}`);
    }
  });

  it('is one file, and a plausible size for one', () => {
    const kb = statSync(PAGE).size / 1024;
    assert.ok(kb > 60, `only ${kb.toFixed(0)} KB — the stylesheet is probably missing`);
    assert.ok(kb < 4096, `${kb.toFixed(0)} KB is too large to open comfortably from disk`);
  });

  it('says it is a preview, and that its data is not live', () => {
    // The one genuinely dishonest thing this file could do is look like it is
    // showing real provider data.
    assert.match(html, /Offline preview/i);
    assert.match(html, /not live provider data|nothing is sent anywhere/i);
  });

  it('regenerates deterministically from the current build', () => {
    // A generated artefact that differs every run cannot be reviewed in a diff,
    // and an artefact nobody reviews is one that quietly stops matching the app.
    const before = readFileSync(PAGE);
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-offline-ui.mjs')], { cwd: ROOT, stdio: 'pipe' });
    assert.deepEqual(readFileSync(PAGE), before, 'regenerating produced different bytes');
  });

  it('ships a README that tells someone how to open it', () => {
    const readme = join(ROOT, 'offline-ui/README.md');
    assert.ok(existsSync(readme), 'offline-ui/README.md is missing');
    const text = readFileSync(readme, 'utf8');
    assert.match(text, /index\.html/);
    assert.match(text, /No installation|no server|file:\/\//i);
  });
});
