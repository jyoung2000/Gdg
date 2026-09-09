#!/usr/bin/env node
/**
 * Fetch the Node runtime the desktop application ships.
 *
 * A user who installs Meridian must not have to install Node, so one goes in
 * the box. That makes Node a redistributed third-party binary, and this script
 * is what makes redistributing it defensible: one pinned version, verified
 * against a digest committed to this repository, extracted to exactly one file,
 * with its licence carried alongside.
 *
 * The digest is the control that matters. `SHASUMS256.txt` fetched from the
 * same host over the same TLS session proves the download matches what that
 * host is serving right now — worth checking, and not the same as proving it is
 * the binary this application was built and tested against. Both are checked.
 *
 *   node scripts/fetch-node-runtime.mjs --platform win32 --arch x64
 *   node scripts/fetch-node-runtime.mjs                       # this host
 *   node scripts/fetch-node-runtime.mjs --check               # verify, don't fetch
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'apps/desktop/runtime.json');
const OUT_ROOT = resolve(ROOT, 'apps/desktop/vendor/node');

function fail(message) {
  process.stderr.write(`\nfetch-node-runtime: ${message}\n\n`);
  process.exit(1);
}

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const platform = flag('platform', process.platform);
const arch = flag('arch', process.arch);
const key = `${platform}-${arch}`;
const checkOnly = process.argv.includes('--check');

const artifact = manifest.artifacts[key];
if (!artifact) {
  fail(
    `no pinned runtime for ${key}.\n` +
      `Known: ${Object.keys(manifest.artifacts).join(', ')}\n` +
      `Adding one means pinning its digest in apps/desktop/runtime.json — never fetching whatever is current.`,
  );
}

const outDir = resolve(flag('out', join(OUT_ROOT, key)));
const outBinary = join(outDir, artifact.out);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The digest of the extracted binary, so a second run can skip the download. */
const stampPath = join(outDir, '.runtime.json');

function alreadyCorrect() {
  if (!existsSync(outBinary) || !existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    return stamp.version === manifest.version && stamp.archiveSha256 === artifact.sha256 && stamp.binarySha256 === sha256(outBinary);
  } catch {
    return false;
  }
}

if (alreadyCorrect()) {
  process.stdout.write(`  node ${manifest.version} (${key}) already present and verified\n`);
  process.exit(0);
}

if (checkOnly) {
  fail(
    `the pinned Node runtime for ${key} is missing or does not match.\n` +
      `Expected ${artifact.file} sha256 ${artifact.sha256}\n` +
      `Run: node scripts/fetch-node-runtime.mjs --platform ${platform} --arch ${arch}`,
  );
}

const url = `${manifest.source}/v${manifest.version}/${artifact.file}`;
const work = mkdtempSync(join(tmpdir(), 'meridian-node-runtime-'));
const archivePath = join(work, artifact.file);

try {
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`download failed with HTTP ${res.status} for ${url}`);
  writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

  const actual = sha256(archivePath);
  if (actual !== artifact.sha256) {
    // This is the whole point of the file. A mismatch is not a retryable
    // network problem; it is a different binary than the one this application
    // was built against, and shipping it would be shipping something nobody
    // tested.
    fail(
      `digest mismatch for ${artifact.file}\n` +
        `  expected ${artifact.sha256}\n` +
        `  actual   ${actual}\n` +
        `Refusing to use it. If upstream legitimately republished this version, update\n` +
        `apps/desktop/runtime.json deliberately — do not weaken this check.`,
    );
  }
  process.stdout.write(`  digest matches the pin in apps/desktop/runtime.json\n`);

  // Cross-check against what the host is publishing today. Not a substitute for
  // the pin — same host, same TLS session — but it is how a legitimate upstream
  // republish is noticed rather than guessed at.
  try {
    const sums = await fetch(`${manifest.source}/v${manifest.version}/SHASUMS256.txt`, { redirect: 'follow' }).then((r) => (r.ok ? r.text() : ''));
    const line = sums.split('\n').find((l) => l.trim().endsWith(artifact.file));
    if (line && line.trim().split(/\s+/)[0] !== artifact.sha256) {
      fail(`upstream SHASUMS256.txt no longer matches the pinned digest for ${artifact.file}. Investigate before changing the pin.`);
    }
    process.stdout.write(line ? '  digest matches upstream SHASUMS256.txt\n' : '  (upstream SHASUMS256.txt unavailable; the pin still held)\n');
  } catch {
    process.stdout.write('  (could not reach upstream SHASUMS256.txt; the pin still held)\n');
  }

  // Extract exactly one file. Unpacking the whole distribution would put npm,
  // corepack, headers and a full documentation tree into an installer that
  // needs none of them.
  process.stdout.write(`  extracting ${artifact.binary}\n`);
  if (artifact.file.endsWith('.zip')) {
    // `unzip` is not always present; Node cannot read zip without a dependency,
    // and Python's zipfile is available on every runner this build targets.
    execFileSync(
      'python3',
      [
        '-c',
        'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);m=z.getinfo(sys.argv[2]);m.filename=sys.argv[4];z.extract(m,sys.argv[3])',
        archivePath,
        artifact.binary,
        work,
        'extracted-binary',
      ],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', work, artifact.binary], { stdio: 'inherit' });
    copyFileSync(join(work, artifact.binary), join(work, 'extracted-binary'));
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(work, 'extracted-binary'), outBinary);
  if (platform !== 'win32') chmodSync(outBinary, 0o755);

  // The licence travels with the binary. Redistributing a runtime without it is
  // the kind of omission that is nobody's problem right up until it is.
  try {
    const licence = await fetch(manifest.license, { redirect: 'follow' }).then((r) => (r.ok ? r.text() : null));
    if (licence && licence.includes('MIT')) writeFileSync(join(outDir, 'LICENSE-node.txt'), licence);
    else throw new Error(`the response from ${manifest.license} does not look like the Node licence`);
  } catch (error) {
    // Not fatal here — a developer building locally is not redistributing
    // anything. scripts/package-desktop.mjs refuses to assemble a payload
    // without this file, so the omission cannot reach a user.
    process.stdout.write(`  WARNING: could not fetch the Node licence text (${error.message}).\n`);
    process.stdout.write('  Packaging will refuse to build a payload until it is present.\n');
  }

  writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        version: manifest.version,
        abi: manifest.abi,
        platform,
        arch,
        archive: artifact.file,
        archiveSha256: artifact.sha256,
        binarySha256: sha256(outBinary),
        source: url,
      },
      null,
      2,
    )}\n`,
  );

  const mb = (statSync(outBinary).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`  node ${manifest.version} (${key}) -> ${outBinary}  ${mb} MB\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
