#!/usr/bin/env node
/**
 * Count the verification statuses across the matrices.
 *
 * The final report quotes a scorecard, and a scorecard typed by hand is a
 * number nobody can check. This derives it from the tables themselves, so
 * editing a row's status changes the total and a stale report is visible.
 *
 * Three modes, and the release uses the middle one:
 *
 *   node scripts/scorecard.mjs           print the scorecard
 *   node scripts/scorecard.mjs --check   fail if the shipped report is stale
 *   node scripts/scorecard.mjs --write   bring the shipped report up to date
 *
 * It also *fails* on a gap. A scorecard that could only ever print was a
 * release step that could not stop a release, and a MISSING or STUB or FAILED
 * row is precisely the thing it exists to notice. `--allow-gaps` prints the
 * count without blocking, for a run that is asking rather than gating.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUSES = ['VERIFIED', 'IMPLEMENTED_UNVERIFIED', 'PARTIAL', 'BLOCKED_EXTERNAL', 'MISSING', 'STUB', 'FAILED'];

const SOURCES = [
  { file: 'docs/VERIFICATION_MATRIX.md', from: '## Gateway and APIs' },
  { file: 'docs/PROVIDER_VERIFICATION.md', from: '## Catalog' },
  { file: 'docs/AGENT_VERIFICATION.md', from: '## Status by agent' },
  { file: 'docs/MODALITY_VERIFICATION.md', from: '| Modality |' },
];

const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
let rows = 0;

for (const source of SOURCES) {
  const text = readFileSync(resolve(root, source.file), 'utf8');
  const index = text.indexOf(source.from);
  if (index < 0) continue;
  for (const line of text.slice(index).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    // A row may carry more than one status column (Meridian's path vs the
    // provider's), so every cell that *is* a status counts as one claim.
    for (const cell of cells.slice(1)) {
      const status = STATUSES.find((s) => cell === s || cell.startsWith(`${s} `) || cell.startsWith(`${s} —`));
      if (!status) continue;
      counts[status] += 1;
      rows += 1;
    }
  }
}

const lines = [
  '| Status | Count | Share |',
  '| --- | ---: | ---: |',
  ...STATUSES.map((s) => {
    const n = counts[s];
    const share = rows ? `${Math.round((n / rows) * 100)}%` : '—';
    return `| ${s} | ${n || 0} | ${n ? share : '—'} |`;
  }),
];

const table = lines.join('\n');
process.stdout.write(`${table}\n\n${rows} claims counted across ${SOURCES.length} matrices.\n`);

const REPORT = resolve(root, 'docs/FINAL_VERIFICATION_REPORT.md');
const SUMMARY = /^\d+ claims across the four matrices, counted by `node scripts\/scorecard\.mjs`\.$/;
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

/**
 * The scorecard block as it should appear, and where it currently sits.
 *
 * The block is the table plus the one sentence under it. Finding its end by
 * looking for the first blank line stopped at the table and left the old
 * sentence in place, so every `--write` added another copy of it — the shipped
 * report had accumulated four.
 */
function spliceScorecard(report) {
  const start = report.indexOf('| Status | Count | Share |');
  if (start < 0) return null;
  const lines = report.slice(start).split('\n');
  let end = 0;
  while (end < lines.length && (lines[end].startsWith('|') || lines[end] === '' || SUMMARY.test(lines[end]))) end += 1;
  // Trailing blank lines belong to the document, not to the block.
  while (end > 0 && lines[end - 1] === '') end -= 1;
  const before = report.slice(0, start);
  const after = report.slice(start + lines.slice(0, end).join('\n').length);
  const block = `${table}\n\n${rows} claims across the four matrices, counted by \`node scripts/scorecard.mjs\`.`;
  return { next: before + block + after, block };
}

if (write || check) {
  const report = readFileSync(REPORT, 'utf8');
  const spliced = spliceScorecard(report);
  if (!spliced) {
    process.stderr.write('No scorecard table found in the final report.\n');
    process.exit(1);
  }
  if (write) {
    writeFileSync(REPORT, spliced.next);
    process.stdout.write(`Wrote the scorecard into ${REPORT}\n`);
  } else if (spliced.next !== report) {
    process.stderr.write(
      'docs/FINAL_VERIFICATION_REPORT.md quotes a scorecard that no longer matches the matrices.\n' +
        'Run `node scripts/scorecard.mjs --write` and commit the result.\n',
    );
    process.exit(1);
  }
}

// A gap is the whole reason to count. Reporting one and exiting 0 made this a
// step that could not stop a release.
const gaps = ['MISSING', 'STUB', 'FAILED'].filter((s) => counts[s] > 0);
if (gaps.length && !process.argv.includes('--allow-gaps')) {
  process.stderr.write(`\n${gaps.map((s) => `${counts[s]} ${s}`).join(', ')} in the verification matrices.\n`);
  process.exit(1);
}
