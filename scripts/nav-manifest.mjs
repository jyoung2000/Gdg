/**
 * The sidebar, read from the application that defines it.
 *
 * The offline UI is plain ES5 with no build step, so it cannot import
 * `App.tsx`. It therefore carried its own copy of the navigation — a list that
 * nothing compared to anything, in a file whose whole purpose is to look like
 * the product. The fingerprint gate could prove the offline UI had been
 * regenerated and could not prove it still matched, because the generator never
 * read the source the nav lives in.
 *
 * Now it does. This parses the one `NAV` array out of `App.tsx` and the
 * generator injects the result, so there is a single list and the offline copy
 * cannot drift. A parse that finds nothing is a hard failure: a silently empty
 * sidebar would be worse than a stale one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'apps/web/src/shell/App.tsx';

export function readNav(root = process.cwd()) {
  const text = readFileSync(join(root, SOURCE), 'utf8');
  const start = text.indexOf('const NAV:');
  if (start < 0) throw new Error(`${SOURCE} no longer declares a NAV array`);
  const open = text.indexOf('[', start);
  const close = text.indexOf('\n];', open);
  if (open < 0 || close < 0) throw new Error(`could not find the bounds of NAV in ${SOURCE}`);

  const body = text.slice(open, close);
  const entries = [];
  const row = /\{\s*id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'[^}]*section:\s*'(primary|more)'\s*\}/g;
  let m;
  while ((m = row.exec(body)) !== null) {
    entries.push({ id: m[1], label: m[2], section: m[3] });
  }

  if (entries.length < 10) {
    throw new Error(`only parsed ${entries.length} nav entries from ${SOURCE} — the shape has changed and the parser has not`);
  }
  if (!entries.some((e) => e.section === 'primary') || !entries.some((e) => e.section === 'more')) {
    throw new Error(`parsed ${entries.length} nav entries from ${SOURCE} but not both sections`);
  }
  return entries;
}
