#!/usr/bin/env node
/**
 * Release verification.
 *
 * Runs every check that can be run here and reports, gate by gate, what the
 * evidence actually supports. It is deliberately unable to report a gate as
 * passing on anything but the tests named against it: a release report whose
 * claims are typed by hand is a report about someone's memory.
 *
 * Statuses are the project's vocabulary and are not interchangeable:
 *
 *   VERIFIED             Exercised here, against the real thing, and it passed.
 *   BLOCKED_EXTERNAL     Cannot be exercised in this environment for a reason
 *                        outside the product — no credential, blocked egress.
 *                        Never a synonym for "probably fine".
 *   FAILED               Exercised and it did not pass.
 *
 * Usage:
 *   node scripts/verify-release.mjs [--json] [--out docs/evidence/RELEASE.md]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 && process.argv[outIndex + 1] ? resolve(root, process.argv[outIndex + 1]) : null;

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...opts.env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, out, ms: Date.now() - started }));
    child.on('error', (e) => resolvePromise({ code: 1, out: String(e), ms: Date.now() - started }));
  });
}

/** Node's test reporter prints these totals; anything else means it did not finish. */
function totals(out) {
  const pass = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? /ℹ pass (\d+)/.exec(out)?.[1] ?? NaN);
  const fail = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? /ℹ fail (\d+)/.exec(out)?.[1] ?? NaN);
  return { pass, fail, parsed: Number.isFinite(pass) && Number.isFinite(fail) };
}

/** Which individual tests passed, so a gate can cite the ones that back it. */
function passedTests(out) {
  const names = new Set();
  for (const m of out.matchAll(/^\s*(?:ok \d+ - |✔ )(.+?)(?: \([\d.]+m?s\))?$/gm)) names.add(m[1].trim());
  return names;
}

const SUITES = [
  { id: 'unit', label: 'Unit', dir: 'tests/unit' },
  { id: 'router', label: 'Routing', dir: 'tests/router' },
  { id: 'contract', label: 'Contract and invariants', dir: 'tests/contract' },
  { id: 'integration', label: 'Gateway integration', dir: 'tests/integration' },
  { id: 'e2e', label: 'End to end', dir: 'tests/e2e' },
  { id: 'chaos', label: 'Chaos', dir: 'tests/chaos' },
];

/**
 * The release gates, each tied to the tests that would have to pass for it to
 * hold. A gate with no evidence is reported as such rather than assumed.
 */
const GATES = [
  {
    id: 'deployment',
    title: 'Deployment: persistence and container configuration',
    tests: [
      'keeps its state across a restart',
      'detects a workspace path that means something else to the Docker daemon',
      'reports the image and daemon it needs, rather than failing at run time',
    ],
    blocked: '`docker compose up -d` and `docker build` need base images from a registry, which this environment\'s egress policy refuses. See docs/evidence/DOCKER.md.',
  },
  {
    id: 'routing',
    title: 'Core routing',
    tests: [
      'completes a chat through the OpenAI surface and reports real usage',
      'honours routing modes and explains a mode it cannot satisfy',
      'never selects a model that cannot serve the requested modality',
      'never spends money unless the request and the instance both allow it',
    ],
  },
  {
    id: 'claude-code',
    title: 'Anthropic-compatible surface, end to end',
    tests: [
      'serves the Anthropic Messages contract, including tool use',
      'streams Anthropic events in the documented order',
      'reassembles a tool call whose arguments arrive as JSON fragments',
    ],
  },
  {
    id: 'pipeline',
    title: 'Autonomous coding pipeline',
    tests: [
      'runs the coding pipeline end to end and writes a real file',
      'checkpoints each step and can take the workspace back to one',
      'forks a task into its own workspace without disturbing the original',
      'runs parallel lanes at the same time, not one after another',
    ],
  },
  {
    id: 'fallback',
    title: 'Fallback and resilience',
    tests: [
      'fails over to a healthy provider when the preferred one refuses',
      'abandons a stream that goes silent instead of hanging on it',
      'builds a fallback chain of distinct targets that excludes the primary',
    ],
  },
  {
    id: 'sandbox',
    title: 'Sandbox isolation',
    tests: [
      'runs the command inside a container against the mounted workspace',
      'lets the command write to the workspace and nowhere else',
      'gives the command no network',
      "does not hand the gateway's environment to the command",
      'kills a command that runs past its timeout',
    ],
  },
  {
    id: 'multimodal',
    title: 'Multimodal surfaces',
    tests: ['serves embeddings through the gateway, deterministically and at the requested width'],
    blocked: 'Image, video, speech and transcription need a credentialed provider; none is configured here.',
  },
  {
    id: 'security',
    title: 'Security',
    tests: [
      'refuses every shape of path escape through the file API',
      'stops an agent that is instructed to read outside the workspace',
      're-checks every redirect hop, not just the URL it was given',
      'refuses a name that resolves into private space',
      'does not let a branch name become a shell command',
      'never returns a stored credential, and redacts one that reaches a log or audit entry',
      'serves model output as data, with a policy that cannot execute it',
      'holds ordinary routes to a small body limit and media routes to the configured one',
    ],
  },
];

/** Test files in a directory, listed explicitly — the runner does not walk directories. */
function testFiles(dir) {
  const abs = resolve(root, dir);
  try {
    return readdirSync(abs)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => join(abs, name))
      .filter((full) => statSync(full).isFile())
      .sort();
  } catch {
    return [];
  }
}

const report = { startedAt: new Date().toISOString(), steps: [], suites: [], gates: [] };

async function step(name, cmd, args, env) {
  process.stdout.write(`→ ${name}\n`);
  const res = await run(cmd, args, { env });
  const ok = res.code === 0;
  process.stdout.write(`  ${ok ? 'ok' : 'FAILED'} (${(res.ms / 1000).toFixed(1)}s)\n`);
  if (!ok) process.stdout.write(`${res.out.split('\n').slice(-25).join('\n')}\n`);
  report.steps.push({ name, ok, ms: res.ms });
  return res;
}

await step('Typecheck', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
await step('Build', 'node', ['scripts/build.mjs']);

const seen = new Set();
for (const suite of SUITES) {
  process.stdout.write(`→ ${suite.label} tests\n`);
  const files = testFiles(suite.dir);
  if (!files.length) {
    process.stdout.write('  FAILED — no test files found\n');
    report.suites.push({ id: suite.id, label: suite.label, ok: false, pass: 0, fail: 0, ms: 0 });
    continue;
  }
  const res = await run('npx', ['tsx', '--test', '--test-reporter', 'spec', ...files]);
  const t = totals(res.out);
  const ok = res.code === 0 && t.parsed && t.fail === 0;
  process.stdout.write(`  ${ok ? `ok — ${t.pass} passed` : 'FAILED'} (${(res.ms / 1000).toFixed(1)}s)\n`);
  if (!ok) process.stdout.write(`${res.out.split('\n').slice(-30).join('\n')}\n`);
  for (const name of passedTests(res.out)) seen.add(name);
  report.suites.push({ id: suite.id, label: suite.label, ok, pass: t.pass, fail: t.fail, ms: res.ms });
}

for (const gate of GATES) {
  const missing = gate.tests.filter((t) => !seen.has(t));
  // Only two statuses are available from a test run: the evidence passed, or it
  // did not. "Blocked" is a fact about the environment, recorded alongside the
  // status rather than substituted for it — a gate whose tests did not run is
  // not blocked, it is unverified, and calling it blocked would be the exact
  // dressing-up this report exists to prevent.
  // A gate whose evidence covers only part of what it names is PARTIAL, never
  // VERIFIED. Rounding that up is how a report starts describing intentions.
  const status = missing.length > 0 ? 'FAILED' : gate.blocked ? 'PARTIAL' : 'VERIFIED';
  report.gates.push({ ...gate, status, missing });
}

const suitesOk = report.suites.every((s) => s.ok);
const stepsOk = report.steps.every((s) => s.ok);
const gatesOk = report.gates.every((g) => g.status === 'VERIFIED' || g.status === 'PARTIAL');
report.finishedAt = new Date().toISOString();
report.ok = suitesOk && stepsOk && gatesOk;

const lines = [];
lines.push('# Release verification');
lines.push('');
lines.push(`Run ${report.startedAt}. Generated by \`node scripts/verify-release.mjs\`; every row below`);
lines.push('comes from a test that ran in this pass, not from a claim typed by hand.');
lines.push('');
lines.push('## Checks');
lines.push('');
lines.push('| Check | Result | Duration |');
lines.push('| --- | --- | --- |');
for (const s of report.steps) lines.push(`| ${s.name} | ${s.ok ? 'pass' : 'FAIL'} | ${(s.ms / 1000).toFixed(1)}s |`);
for (const s of report.suites) {
  lines.push(`| ${s.label} tests | ${s.ok ? `pass (${s.pass})` : `FAIL (${s.fail} failing)`} | ${(s.ms / 1000).toFixed(1)}s |`);
}
lines.push('');
lines.push('## Gates');
lines.push('');
lines.push('| Gate | Status | Backed by |');
lines.push('| --- | --- | --- |');
for (const g of report.gates) {
  const backing = g.missing.length
    ? `no result for: ${g.missing.join('; ')}`
    : `${g.tests.length} passing test(s)${g.status === 'PARTIAL' ? ', covering part of this gate — see below' : ''}`;
  lines.push(`| ${g.title} | ${g.status} | ${backing} |`);
}
const blocked = report.gates.filter((g) => g.blocked);
if (blocked.length) {
  lines.push('');
  lines.push('### Not covered here (BLOCKED_EXTERNAL)');
  lines.push('');
  lines.push('These are outside the product and are not counted as passing.');
  lines.push('');
  for (const g of blocked) lines.push(`- **${g.title}** — ${g.blocked}`);
}
lines.push('');
lines.push(
  report.ok
    ? 'Every gate is backed by evidence from this run; the ones marked PARTIAL name what is not covered.'
    : 'At least one gate is not backed by evidence from this run.',
);
lines.push('');

const markdown = lines.join('\n');
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  process.stdout.write(`\nWrote ${outPath}\n`);
}
if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`\n${markdown}`);

process.exit(report.ok ? 0 : 1);
