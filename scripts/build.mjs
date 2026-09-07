#!/usr/bin/env node
/**
 * Build script.
 *
 * Internal packages are consumed as TypeScript source rather than being built
 * individually, so there is exactly one bundling step per deployable: esbuild
 * for the two Node entry points, Vite for the web client. That removes a whole
 * class of stale-build problems from a workspace this size.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsconfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));

/** Map the tsconfig path aliases into esbuild's alias form. */
const alias = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths)
    .filter(([key]) => !key.endsWith('/*'))
    .map(([key, [value]]) => [key, resolve(root, value)]),
);

function run(command, args, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${label} failed with exit code ${code}`))));
    child.on('error', reject);
  });
}

async function bundleNode(entry, outfile, label) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    minify: false,
    alias,
    // better-sqlite3 is a native addon: bundling it would break the .node
    // binding resolution, so it stays external and is required at runtime.
    //
    // playwright-core is external for a related reason: it lazily requires
    // optional transport backends and resolves a browser binary relative to
    // its own install path. Bundling it fails outright on those optional
    // requires, and would break binary resolution even if it linked.
    external: ['better-sqlite3', 'playwright-core'],
    banner: {
      // esbuild's ESM output loses CommonJS interop that some dependencies
      // still reach for; this restores require() inside the bundle.
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
    logLevel: 'info',
  });
  process.stdout.write(`  built ${label} -> ${outfile}\n`);
}

const target = process.argv[2] ?? 'all';

if (target === 'all' || target === 'gateway') {
  await bundleNode('apps/gateway/src/main.ts', 'dist/gateway/main.js', 'gateway');
}
if (target === 'all' || target === 'cli') {
  await bundleNode('apps/cli/src/uag.ts', 'dist/cli/uag.js', 'cli');
}
if (target === 'all' || target === 'web') {
  await run('npx', ['vite', 'build', '--config', 'apps/web/vite.config.ts'], 'vite build');
  // The gateway serves the client from dist/web so a container copy is one path.
  mkdirSync(resolve(root, 'dist'), { recursive: true });
  if (existsSync(resolve(root, 'apps/web/dist'))) {
    cpSync(resolve(root, 'apps/web/dist'), resolve(root, 'dist/web'), { recursive: true });
    process.stdout.write('  built web -> dist/web\n');
  }
}
