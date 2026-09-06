#!/usr/bin/env node
/**
 * Run the live-provider suite.
 *
 * Live tests send real requests with real credentials, and some of those
 * requests cost money. Neither happens by accident:
 *
 *   - Nothing runs without at least one provider credential in the environment.
 *   - Nothing that can charge runs unless ALLOW_PAID_LIVE_TESTS=true.
 *   - Nothing that can charge runs without LIVE_TEST_MAX_COST_USD naming a
 *     ceiling, which the suite tracks against actual reported usage and stops
 *     at.
 *
 * The gate is here rather than only inside the tests so that a mistyped
 * variable fails loudly before a single request is sent.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowPaid = process.env.ALLOW_PAID_LIVE_TESTS === 'true';
const ceiling = Number(process.env.LIVE_TEST_MAX_COST_USD ?? '');

if (allowPaid && !(Number.isFinite(ceiling) && ceiling > 0)) {
  process.stderr.write(
    'ALLOW_PAID_LIVE_TESTS=true requires LIVE_TEST_MAX_COST_USD to be a positive number.\n' +
      'Permission to spend without a ceiling is not permission this runner will accept.\n',
  );
  process.exit(2);
}

process.stdout.write(
  allowPaid
    ? `Live suite: paid requests permitted, ceiling $${ceiling}.\n`
    : 'Live suite: free and local providers only. Set ALLOW_PAID_LIVE_TESTS=true and LIVE_TEST_MAX_COST_USD to include paid ones.\n',
);

const child = spawn('npx', ['tsx', '--test', '--test-reporter', 'spec', 'tests/live/providers.live.test.ts'], {
  cwd: root,
  stdio: 'inherit',
});
child.on('close', (code) => process.exit(code ?? 1));
