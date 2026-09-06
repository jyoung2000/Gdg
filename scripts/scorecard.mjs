#!/usr/bin/env node
/**
 * Count the verification statuses across the matrices.
 *
 * The final report quotes a scorecard, and a scorecard typed by hand is a
 * number nobody can check. This derives it from the tables themselves, so
 * editing a row's status changes the total and a stale report is visible.
 *
 * Usage: node scripts/scorecard.mjs [--write]
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

if (process.argv.includes('--write')) {
  const path = resolve(root, 'docs/FINAL_VERIFICATION_REPORT.md');
  const report = readFileSync(path, 'utf8');
  const start = report.indexOf('| Status | Count | Share |');
  if (start < 0) {
    process.stderr.write('No scorecard table found in the final report.\n');
    process.exit(1);
  }
  const end = report.indexOf('\n\n', start);
  const next = `${table}\n\n${rows} claims across the four matrices, counted by \`node scripts/scorecard.mjs\`.`;
  writeFileSync(path, report.slice(0, start) + next + report.slice(end + 1));
  process.stdout.write(`Wrote the scorecard into ${path}\n`);
}
