import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Every workspace package must declare what it imports.
 *
 * This repository builds with esbuild and tests with tsx, and both resolve
 * `@meridian/*` through the tsconfig `paths` map. That is convenient and it
 * hides a real defect: a package can import a sibling it never declared, pnpm
 * never links it, and everything works — until something resolves modules the
 * normal way. `pnpm deploy --filter`, a per-package `tsc` emit, or plain Node
 * all fail on an import the manifest does not mention.
 *
 * Two were found this way: the gateway imported `@meridian/context-sdk` and
 * `@meridian/control-sdk` with neither in its dependencies and neither linked
 * into its `node_modules`.
 */
function packageDirs(): { name: string; dir: string; pkg: Record<string, unknown> }[] {
  const found: { name: string; dir: string; pkg: Record<string, unknown> }[] = [];
  for (const root of ['apps', 'packages']) {
    const base = join(ROOT, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      found.push({ name: String(pkg.name ?? entry), dir: join(base, entry), pkg });
    }
  }
  return found;
}

function sourceFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, files);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('Workspace manifests', () => {
  const packages = packageDirs();

  it('finds the workspace packages at all', () => {
    // A silent zero here would make every assertion below vacuously true.
    assert.ok(packages.length >= 8, `only found ${packages.length} workspace packages`);
  });

  it('declares every @meridian package it imports', () => {
    const problems: string[] = [];
    for (const { name, dir, pkg } of packages) {
      const declared = new Set(
        Object.keys({
          ...((pkg.dependencies as Record<string, string>) ?? {}),
          ...((pkg.devDependencies as Record<string, string>) ?? {}),
          ...((pkg.peerDependencies as Record<string, string>) ?? {}),
        }),
      );
      const imported = new Set<string>();
      for (const file of sourceFiles(join(dir, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/from ['"](@meridian\/[a-z-]+)['"]/g)) imported.add(m[1]);
        for (const m of text.matchAll(/import\(['"](@meridian\/[a-z-]+)['"]\)/g)) imported.add(m[1]);
      }
      for (const dep of imported) {
        if (dep === name) continue;
        if (!declared.has(dep)) problems.push(`${name} imports ${dep} but does not declare it`);
      }
    }
    assert.deepEqual(problems, [], `undeclared workspace dependencies:\n  ${problems.join('\n  ')}`);
  });

  it('links every declared @meridian dependency into node_modules', () => {
    // The manifest can be right and the tree still wrong if nobody re-ran the
    // install. This catches the half-fixed state.
    const problems: string[] = [];
    for (const { name, dir, pkg } of packages) {
      const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {}).filter((d) => d.startsWith('@meridian/'));
      for (const dep of deps) {
        if (!existsSync(join(dir, 'node_modules', dep))) {
          problems.push(`${name} declares ${dep} but it is not linked — run pnpm install`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n  '));
  });
});
