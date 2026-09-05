#!/usr/bin/env node
/**
 * Test runner.
 *
 * Node's own test runner under tsx, so the suite runs the same TypeScript
 * sources the product does — no build step between what is tested and what
 * ships.
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv[2] ?? 'all';

const GROUPS = {
  unit: ['tests/unit'],
  router: ['tests/router'],
  integration: ['tests/integration'],
  chaos: ['tests/chaos'],
  all: ['tests/unit', 'tests/router', 'tests/integration', 'tests/chaos'],
};

const dirs = GROUPS[suite];
if (!dirs) {
  process.stderr.write(`Unknown suite "${suite}". One of: ${Object.keys(GROUPS).join(', ')}\n`);
  process.exit(1);
}

const files = [];
for (const dir of dirs) {
  const abs = resolve(root, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    continue;
  }
  for (const name of entries) {
    const full = join(abs, name);
    if (statSync(full).isFile() && name.endsWith('.test.ts')) files.push(full);
  }
}

if (!files.length) {
  process.stderr.write('No test files found.\n');
  process.exit(1);
}

const child = spawn('npx', ['tsx', '--test', '--test-reporter', 'spec', ...files], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('close', (code) => process.exit(code ?? 1));
