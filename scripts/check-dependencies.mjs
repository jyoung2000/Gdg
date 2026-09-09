#!/usr/bin/env node
/**
 * Known vulnerabilities in what actually ships.
 *
 * There was no dependency check anywhere — not in CI, not in the release
 * verification, not in a script — and the tree carried a high-severity path
 * traversal in the gateway's static file server the whole time. A release
 * routine that never asks cannot be surprised.
 *
 * `--prod` because development tooling is not handed to users: a test runner's
 * advisory is worth fixing, but it is not a reason to block a release, and
 * mixing the two produces noise nobody reads.
 *
 * The failure line is `high`. Everything found is printed either way, so a
 * moderate is visible rather than swallowed; what changes at `high` is whether
 * the release stops. That is a policy, and it is written here so it can be
 * argued with rather than discovered.
 *
 *   node scripts/check-dependencies.mjs
 *   node scripts/check-dependencies.mjs --fail-on moderate
 */
import { spawnSync } from 'node:child_process';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const argIndex = process.argv.indexOf('--fail-on');
const threshold = argIndex === -1 ? 'high' : process.argv[argIndex + 1];
if (!(threshold in RANK)) {
  console.error(`--fail-on must be one of ${Object.keys(RANK).join(', ')}`);
  process.exit(1);
}

const run = spawnSync('pnpm', ['audit', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// A non-zero exit is how `pnpm audit` reports findings, so it is not on its own
// an error. A missing registry is, and the two look different: no parsable
// JSON at all.
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('Could not read the audit report. The registry may be unreachable from here.');
  if (run.stderr) console.error(run.stderr.trim().split('\n').slice(0, 5).join('\n'));
  // An unreachable registry is not a clean bill of health, and must not be
  // reported as one.
  process.exit(2);
}

const advisories = Object.values(report.advisories ?? {});
if (!advisories.length) {
  console.log('No known vulnerabilities in the production dependency tree.');
  process.exit(0);
}

const blocking = [];
for (const a of advisories) {
  const severity = String(a.severity ?? 'info').toLowerCase();
  const paths = [...new Set((a.findings ?? []).flatMap((f) => f.paths ?? []))];
  const line = `  [${severity}] ${a.module_name}: ${a.title}\n      installed ${paths.join(', ') || 'unknown path'}\n      fixed in ${a.patched_versions ?? 'no published fix'} — ${a.url ?? ''}`;
  console.log(line);
  if ((RANK[severity] ?? 0) >= RANK[threshold]) blocking.push(a);
}

console.log(`\n${advisories.length} advisory/advisories found; ${blocking.length} at or above "${threshold}".`);
if (blocking.length) {
  console.error(`\nRelease blocked: ${blocking.length} advisory/advisories at or above "${threshold}".`);
  process.exit(1);
}
