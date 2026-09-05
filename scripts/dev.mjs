#!/usr/bin/env node
/**
 * Development runner: the gateway under tsx with the Vite dev server proxying
 * to it, so both halves reload independently.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  return child;
}

start('npx', ['tsx', 'watch', 'apps/gateway/src/main.ts'], {
  MERIDIAN_LOG_FORMAT: 'pretty',
  MERIDIAN_LOG_LEVEL: process.env.MERIDIAN_LOG_LEVEL ?? 'debug',
});
start('npx', ['vite', '--config', 'apps/web/vite.config.ts']);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
