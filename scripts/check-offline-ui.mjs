#!/usr/bin/env node
/**
 * The offline artefacts are release artefacts, so they get a release gate.
 *
 * Both are generated from the running application, which is what makes them
 * faithful and also what makes them dangerous: they go stale in silence. Change
 * a screen, rebuild, ship — and the file someone opens from disk still shows
 * last week's interface, looking entirely convincing. There is no error, no
 * missing file, nothing to notice.
 *
 * So this refuses to agree that an artefact is current unless it carries the
 * fingerprint of the UI source that exists right now, and refuses to call it
 * offline unless the bytes contain nothing a browser would go to the network
 * for.
 *
 *   node scripts/check-offline-ui.mjs [--json]
 *
 * Exits nonzero on any failure, so it can be a gate rather than a suggestion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kb, readFingerprint, uiFingerprint } from './ui-fingerprint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const ARTEFACTS = [
  {
    path: 'offline-ui/index.html',
    label: 'Offline UI',
    regenerate: 'pnpm build:offline-ui',
    minKb: 60,
  },
  {
    path: 'docs/mockup/meridian-gui-mockup.html',
    label: 'GUI mockup',
    // Needs a running gateway, because it captures the real rendered DOM.
    regenerate: 'pnpm mockup',
    minKb: 300,
  },
];

/**
 * Ways a page reaches the network.
 *
 * Comments are stripped first. The bundled stylesheet carries MIT licence
 * notices and those notices cite URLs — that is the attribution the licence
 * requires, and a check that flagged it would push someone toward deleting a
 * copyright notice to get a green build.
 */
const NETWORK = [
  [/<script[^>]+\bsrc\s*=/i, 'an external <script src>'],
  [/<link[^>]+\brel\s*=\s*["']?stylesheet/i, 'an external stylesheet <link>'],
  [/<img[^>]+\bsrc\s*=\s*["'](?!data:)/i, 'an <img> with a non-data source'],
  [/@import\s+(?!url\(["']?data:)/i, 'a CSS @import'],
  [/url\((?!['"]?data:)[^)]*\)/i, 'a CSS url() that is not a data: URI'],
  [/\b(?:src|href)\s*=\s*["']https?:/i, 'an element pointing at an absolute URL'],
];

const current = uiFingerprint(ROOT);
const results = [];
let failed = 0;

for (const artefact of ARTEFACTS) {
  const full = join(ROOT, artefact.path);
  const problems = [];

  if (!existsSync(full)) {
    problems.push(`missing — regenerate with \`${artefact.regenerate}\``);
    results.push({ ...artefact, ok: false, problems, sizeKb: 0, fingerprint: null });
    failed += 1;
    continue;
  }

  const html = readFileSync(full, 'utf8');
  const stamped = readFingerprint(html);
  const sizeKb = kb(full);

  if (!stamped) {
    problems.push('carries no UI fingerprint, so nothing can say whether it is current — regenerate it');
  } else if (stamped !== current.hash) {
    problems.push(
      `stale: built from UI source ${stamped}, but the source is now ${current.hash} — regenerate with \`${artefact.regenerate}\``,
    );
  }

  const fetchable = html.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const [pattern, what] of NETWORK) {
    const hit = pattern.exec(fetchable);
    if (hit) problems.push(`not self-contained: contains ${what} (${hit[0].slice(0, 80)})`);
  }

  if (sizeKb < artefact.minKb) {
    problems.push(`only ${sizeKb} KB — expected at least ${artefact.minKb} KB, so something did not get embedded`);
  }

  const ok = problems.length === 0;
  if (!ok) failed += 1;
  results.push({ ...artefact, ok, problems, sizeKb, fingerprint: stamped });
}

/**
 * The preview screenshots, which are the artefact people actually look at.
 *
 * A PNG cannot carry a comment, so `pnpm mockup` writes the fingerprint beside
 * them. Without this the gate could tell the mockup was stale and say nothing
 * at all about the pictures — which is how seven screenshots came to show a
 * sidebar the product had not had for weeks.
 */
const PREVIEWS = ['chat', 'projects', 'director', 'discover', 'computer', 'models', 'settings'];
const sidecarPath = join(ROOT, 'docs/mockup/previews.json');
const previewProblems = [];
let previewStamp = null;

if (!existsSync(sidecarPath)) {
  previewProblems.push('docs/mockup/previews.json is missing, so nothing records when the previews were taken');
} else {
  let readable = true;
  try {
    previewStamp = JSON.parse(readFileSync(sidecarPath, 'utf8')).uiFingerprint ?? null;
  } catch {
    readable = false;
    previewProblems.push('docs/mockup/previews.json is not readable JSON');
  }
  // A sidecar that parses but carries no fingerprint is the same problem as no
  // sidecar at all, and used to pass: the comparison was guarded on the stamp
  // existing, so an absent one skipped the check entirely and the PNGs were
  // reported current. The HTML artefacts above already say this out loud; the
  // pictures are the thing people actually look at, so they get it too.
  if (readable && !previewStamp) {
    previewProblems.push(
      'docs/mockup/previews.json records no uiFingerprint, so nothing can say whether the previews are current',
    );
  } else if (readable && previewStamp !== current.hash) {
    previewProblems.push(`stale: shot from UI source ${previewStamp}, but the source is now ${current.hash}`);
  }
}
for (const id of PREVIEWS) {
  const file = join(ROOT, `docs/mockup/preview-${id}.png`);
  if (!existsSync(file)) previewProblems.push(`preview-${id}.png is missing`);
}
if (previewProblems.length) {
  previewProblems.push('regenerate with `pnpm mockup`');
  failed += 1;
}
results.push({
  path: 'docs/mockup/preview-*.png',
  label: 'Previews',
  regenerate: 'pnpm mockup',
  ok: previewProblems.length === 0,
  problems: previewProblems,
  sizeKb: PREVIEWS.reduce((n, id) => {
    const f = join(ROOT, `docs/mockup/preview-${id}.png`);
    return n + (existsSync(f) ? kb(f) : 0);
  }, 0),
  fingerprint: previewStamp,
});

if (asJson) {
  process.stdout.write(`${JSON.stringify({ uiFingerprint: current, artefacts: results, ok: failed === 0 }, null, 2)}\n`);
} else {
  process.stdout.write(`UI source fingerprint: ${current.hash} (${current.files} files)\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(12)} ${r.path} (${r.sizeKb} KB)\n`);
    for (const p of r.problems) process.stdout.write(`       ${p}\n`);
  }
  process.stdout.write(
    failed === 0
      ? '\n  every offline artefact is current and self-contained\n'
      : `\n  ${failed} offline artefact(s) would ship stale or broken\n`,
  );
}

process.exit(failed === 0 ? 0 : 1);
