#!/usr/bin/env node
/**
 * One release, one version number.
 *
 * The version used to be a string literal in about twenty places: every
 * workspace manifest, the Tauri bundle, the Cargo crate, two MCP handshakes,
 * and `GET /api/system/info` — which is the one a user reads when they are
 * trying to tell you what they are running. Nothing kept them equal, so
 * "which version is this?" had several answers and no way to tell which was
 * right.
 *
 * The root `package.json` is the source of truth. This fails the release when
 * anything disagrees with it, and `--write` makes everything agree in one go,
 * which is what bumping a release should take.
 *
 *   node scripts/check-version.mjs
 *   node scripts/check-version.mjs --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes('--write');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const canonical = JSON.parse(read('package.json')).version;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(canonical)) {
  console.error(`The root package.json version "${canonical}" is not a semantic version.`);
  process.exit(1);
}

/** Every workspace manifest, found rather than listed, so a new package is covered the day it lands. */
function manifests() {
  const out = [];
  for (const group of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(ROOT, group));
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = `${group}/${name}/package.json`;
      try {
        if (statSync(join(ROOT, rel)).isFile()) out.push(rel);
      } catch {
        // Not a package; skip.
      }
    }
  }
  return out;
}

const problems = [];
const fixed = [];

/** A JSON file whose top-level `version` must match. */
function checkJson(rel) {
  let text;
  try {
    text = read(rel);
  } catch {
    return; // An optional file that this checkout does not have.
  }
  const found = JSON.parse(text).version;
  if (found === canonical) return;
  if (write) {
    // Edited as text, not re-serialised: `JSON.stringify` would reformat the
    // whole file and bury a one-line change in a hundred lines of diff.
    const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${canonical}"`);
    writeFileSync(join(ROOT, rel), next);
    fixed.push(`${rel}: ${found} → ${canonical}`);
    return;
  }
  problems.push(`${rel} says ${found}, the root says ${canonical}`);
}

/** The Rust crate, whose version is what the built `Meridian.exe` reports. */
function checkCargo(rel) {
  let text;
  try {
    text = read(rel);
  } catch {
    return;
  }
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) return;
  if (match[1] === canonical) return;
  if (write) {
    writeFileSync(join(ROOT, rel), text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${canonical}"`));
    fixed.push(`${rel}: ${match[1]} → ${canonical}`);
    return;
  }
  problems.push(`${rel} says ${match[1]}, the root says ${canonical}`);
}

/** The constant the running product reports about itself. */
function checkConstant(rel) {
  const text = read(rel);
  const match = text.match(/MERIDIAN_VERSION\s*=\s*'([^']+)'/);
  if (!match) {
    problems.push(`${rel} no longer declares MERIDIAN_VERSION`);
    return;
  }
  if (match[1] === canonical) return;
  if (write) {
    writeFileSync(join(ROOT, rel), text.replace(/(MERIDIAN_VERSION\s*=\s*)'[^']+'/, `$1'${canonical}'`));
    fixed.push(`${rel}: ${match[1]} → ${canonical}`);
    return;
  }
  problems.push(`${rel} says ${match[1]}, the root says ${canonical}`);
}

/**
 * A version still written out by hand somewhere it should be imported from.
 *
 * Catches the next literal before it becomes the next disagreement.
 */
function checkForStragglers() {
  const roots = ['apps', 'packages'];
  const skip = new Set(['node_modules', 'dist', 'target', '.turbo']);
  const literal = new RegExp(`version:\\s*'${canonical.replace(/\./g, '\\.')}'`);
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (skip.has(entry)) continue;
      const rel = `${dir}/${entry}`;
      const s = statSync(join(ROOT, rel));
      if (s.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry) && literal.test(readFileSync(join(ROOT, rel), 'utf8'))) {
        problems.push(`${rel} writes the version out by hand; import MERIDIAN_VERSION instead`);
      }
    }
  };
  for (const r of roots) walk(r);
}

for (const rel of manifests()) checkJson(rel);
checkJson('apps/desktop/src-tauri/tauri.conf.json');
checkCargo('apps/desktop/src-tauri/Cargo.toml');
checkConstant('packages/shared/src/version.ts');
if (!write) checkForStragglers();

if (write) {
  if (!fixed.length) console.log(`Everything already says ${canonical}.`);
  for (const line of fixed) console.log(`  updated ${line}`);
  console.log('\nRun `cargo update -p meridian-desktop` if the Cargo lockfile needs to follow.');
  process.exit(0);
}

if (problems.length) {
  console.error(`Version disagreement — the root package.json says ${canonical}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nRun `node scripts/check-version.mjs --write` to make everything agree.');
  process.exit(1);
}

console.log(`Every manifest, the desktop bundle, the Rust crate and MERIDIAN_VERSION all say ${canonical}.`);
