/**
 * A content fingerprint of the web client's source.
 *
 * The offline artefacts are generated from the running app, which means they go
 * stale silently: change a screen, rebuild, ship — and the file someone opens
 * from disk still shows last week's interface, looking entirely convincing.
 *
 * Modification times cannot catch that. Git does not preserve them, so every
 * fresh clone has artefacts that look newer than the source they were built
 * from, and the check would pass on exactly the machine that has never
 * regenerated anything. A hash of the source content is the same on every
 * machine and changes when, and only when, the interface does.
 *
 * Each generator embeds this value; `check-offline-ui.mjs` recomputes it and
 * refuses to agree that an artefact is current when it is not.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The trees whose contents decide what the interface looks like. */
export const UI_SOURCES = ['apps/web/src', 'packages/ui/src'];

const RELEVANT = /\.(tsx?|css|jsx?)$/;

function walk(root, dir, files) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, files);
    else if (RELEVANT.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * Hash every source file that can change how the client looks.
 *
 * Paths are included alongside contents, and sorted, so that renaming or moving
 * a file changes the fingerprint too — a screen that moved is a screen the
 * mockup no longer shows in the right place.
 */
export function uiFingerprint(root = process.cwd()) {
  const hash = createHash('sha256');
  const files = [];
  for (const source of UI_SOURCES) walk(root, join(root, source), files);
  files.sort();
  for (const file of files) {
    hash.update(relative(root, file).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { hash: hash.digest('hex').slice(0, 16), files: files.length };
}

export const FINGERPRINT_MARKER = 'meridian-ui-fingerprint';

/** The comment a generator embeds so the artefact carries its own provenance. */
export function fingerprintComment(fp) {
  return `<!-- ${FINGERPRINT_MARKER}: ${fp.hash} (${fp.files} source files) -->`;
}

/** Read the fingerprint back out of a generated artefact, or null if absent. */
export function readFingerprint(html) {
  const m = new RegExp(`${FINGERPRINT_MARKER}:\\s*([0-9a-f]+)`).exec(html);
  return m ? m[1] : null;
}

/** How large a file is, for the report. */
export function kb(path) {
  return existsSync(path) ? Math.round(statSync(path).size / 1024) : 0;
}
