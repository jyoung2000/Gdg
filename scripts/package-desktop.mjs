#!/usr/bin/env node
/**
 * Assemble everything the desktop application runs, and nothing else.
 *
 * The installed application has to start Meridian on a machine with no Node, no
 * pnpm, no compiler and no network. That means the payload is not "the repo
 * minus some things" — it is an explicit list, because the failure mode of
 * guessing is an installer that works on the machine that built it.
 *
 * Three parts:
 *
 *   runtime/    one pinned node binary, verified by digest
 *   server/     the gateway bundle, the web client, and the exact node_modules
 *               esbuild left external
 *   payload.json  what is in here and what it was built from
 *
 * The node_modules subset is an allowlist rather than a copy of the workspace
 * tree. `node_modules` here is 700 MB of build tooling; the gateway needs three
 * packages, one of which is a native addon. Copying the tree would ship a
 * compiler toolchain to end users and hide which files actually matter.
 *
 *   node scripts/package-desktop.mjs --platform win32 --arch x64
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`\npackage-desktop: ${message}\n\n`);
  process.exit(1);
}

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const platform = flag('platform', process.platform);
const arch = flag('arch', process.arch);
const key = `${platform}-${arch}`;
const outDir = resolve(flag('out', join(ROOT, 'apps/desktop/payload')));
/** Source maps are a debug aid worth 12 MB of installer to some builds and not to most. */
const withMaps = process.argv.includes('--with-sourcemaps');

const manifest = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/runtime.json'), 'utf8'));
const artifact = manifest.artifacts[key];
if (!artifact) fail(`no pinned Node runtime for ${key}; see apps/desktop/runtime.json`);

/**
 * The node_modules the gateway bundle genuinely needs at runtime.
 *
 * These are the packages esbuild was told to leave external, plus their own
 * runtime dependencies — not their build dependencies. `prebuild-install` is a
 * dependency of `better-sqlite3` and runs only during `npm install`; shipping
 * it would put a downloader into the installed application for no reason.
 *
 * `playwright-core` is deliberately absent. The gateway imports it lazily and
 * reports browser features as unavailable when it is missing, so leaving it out
 * costs an optional capability rather than a boot failure — and including it
 * would mean shipping a browser, which is a different product decision.
 */
const RUNTIME_MODULES = [
  {
    name: 'better-sqlite3',
    // An allowlist, because the package ships the whole SQLite amalgamation and
    // a build directory full of intermediates: 12 MB, of which ~2 is needed.
    include: ['package.json', 'LICENSE', 'lib', join('build', 'Release', 'better_sqlite3.node')],
    native: join('build', 'Release', 'better_sqlite3.node'),
  },
  { name: 'bindings', include: ['package.json', 'LICENSE.md', 'bindings.js'] },
  { name: 'file-uri-to-path', include: ['package.json', 'LICENSE', 'index.js'] },
];

/* ------------------------------------------------------------------ */
/* Copy helpers                                                        */
/* ------------------------------------------------------------------ */

const copied = [];

function copyInto(from, to, { skipMaps = false } = {}) {
  if (!existsSync(from)) fail(`missing build input: ${from}\nRun \`pnpm build\` first.`);
  const stat = statSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) copyInto(join(from, entry), join(to, entry), { skipMaps });
    return;
  }
  if (skipMaps && from.endsWith('.map')) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied.push(relative(outDir, to).split(sep).join('/'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Assemble                                                            */
/* ------------------------------------------------------------------ */

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. The runtime.
const runtimeSrc = join(ROOT, 'apps/desktop/vendor/node', key, artifact.out);
if (!existsSync(runtimeSrc)) {
  fail(
    `the pinned Node runtime for ${key} is not present.\n` +
      `Run: node scripts/fetch-node-runtime.mjs --platform ${platform} --arch ${arch}`,
  );
}
copyInto(runtimeSrc, join(outDir, 'runtime', artifact.out));
// Node is MIT, and MIT requires its notice to travel with the binary. The fetch
// step is best-effort — a network failure there should not stop a developer
// building — but *packaging* is the point where the payload becomes something
// handed to other people, so a missing notice fails here rather than shipping.
const licenceSrc = join(ROOT, 'apps/desktop/vendor/node', key, 'LICENSE-node.txt');
if (!existsSync(licenceSrc)) {
  fail(
    `the Node licence text is missing from apps/desktop/vendor/node/${key}.\n` +
      '  Redistributing the runtime without it does not satisfy its MIT licence.\n' +
      `  Re-run: node scripts/fetch-node-runtime.mjs --platform ${platform} --arch ${arch}`,
  );
}
copyInto(licenceSrc, join(outDir, 'runtime', 'LICENSE-node.txt'));

// 2. The gateway bundle and the web client.
copyInto(join(ROOT, 'dist/gateway/main.js'), join(outDir, 'server/gateway/main.js'));
if (withMaps && existsSync(join(ROOT, 'dist/gateway/main.js.map'))) {
  copyInto(join(ROOT, 'dist/gateway/main.js.map'), join(outDir, 'server/gateway/main.js.map'));
}
copyInto(join(ROOT, 'dist/web'), join(outDir, 'server/web'), { skipMaps: !withMaps });

// 2b. The schema. Migrations are plain .sql files read at boot, not compiled
// into the bundle, so a payload without them starts and immediately fails on an
// empty database — which is exactly what verify-desktop-payload caught the
// first time this script ran.
copyInto(join(ROOT, 'database/migrations'), join(outDir, 'server/database/migrations'));

// 3. The runtime modules, file by file.
for (const mod of RUNTIME_MODULES) {
  const src = join(ROOT, 'node_modules', mod.name);
  if (!existsSync(src)) fail(`${mod.name} is not installed. Run \`pnpm install\`.`);
  for (const entry of mod.include) {
    const from = join(src, entry);
    // LICENSE filenames vary; a missing one is worth a warning, not a failure.
    if (!existsSync(from)) {
      if (/^LICEN[CS]E/i.test(entry)) {
        process.stdout.write(`  note: ${mod.name} has no ${entry}\n`);
        continue;
      }
      fail(`${mod.name} is missing ${entry}, which the payload requires`);
    }
    copyInto(from, join(outDir, 'server/node_modules', mod.name, entry));
  }
}

/* ------------------------------------------------------------------ */
/* Refuse a payload that cannot run                                    */
/* ------------------------------------------------------------------ */

const nativePath = join(outDir, 'server/node_modules/better-sqlite3', RUNTIME_MODULES[0].native);

/**
 * A native addon built for the wrong operating system.
 *
 * The most likely packaging mistake there is, and the least visible: cross-
 * building a Windows payload on Linux copies the Linux `.node`, which looks
 * entirely correct on disk and fails at `require` on a user's machine with an
 * error most people would read as a corrupt install.
 *
 * The magic bytes settle it without running anything. Failing here rather than
 * in the verifier is deliberate — a bad artefact that exists is a bad artefact
 * somebody can ship by skipping a step.
 */
function binaryFormat(path) {
  const head = readFileSync(path).subarray(0, 4);
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  if (head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF') return 'elf';
  if (head.readUInt32LE(0) === 0xfeedfacf || head.readUInt32BE(0) === 0xcafebabe) return 'macho';
  return 'unknown';
}

const expectedFormat = platform === 'win32' ? 'pe' : platform === 'darwin' ? 'macho' : 'elf';
const actualFormat = binaryFormat(nativePath);
if (actualFormat !== expectedFormat) {
  rmSync(outDir, { recursive: true, force: true });
  fail(
    `better-sqlite3's native addon is a ${actualFormat} binary, and a ${platform} payload needs ${expectedFormat}.\n\n` +
      `The installed node_modules were built for ${process.platform}, so this payload would fail at require() on a\n` +
      `user's machine — after installing cleanly, which is the worst way to find out.\n\n` +
      `A ${platform} payload has to be assembled on ${platform}, where \`pnpm install\` fetches or builds the right\n` +
      `binary. That is what the Windows CI job is for. The output directory has been removed rather than left\n` +
      `as something that looks finished.`,
  );
}
/* ------------------------------------------------------------------ */
/* Describe what was built                                             */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const payload = {
  app: 'Meridian',
  version: pkg.version,
  platform,
  arch,
  builtOn: `${process.platform}-${process.arch}`,
  node: {
    version: manifest.version,
    abi: manifest.abi,
    binary: `runtime/${artifact.out}`,
    sha256: sha256(join(outDir, 'runtime', artifact.out)),
  },
  server: {
    entry: 'server/gateway/main.js',
    web: 'server/web',
    migrations: 'server/database/migrations',
    sha256: sha256(join(outDir, 'server/gateway/main.js')),
  },
  native: {
    'better-sqlite3': {
      version: JSON.parse(readFileSync(join(ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8')).version,
      binary: `server/node_modules/better-sqlite3/${RUNTIME_MODULES[0].native.split(sep).join('/')}`,
      sha256: sha256(nativePath),
    },
  },
  sourcemaps: withMaps,
  files: copied.length,
};
writeFileSync(join(outDir, 'payload.json'), `${JSON.stringify(payload, null, 2)}\n`);

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

process.stdout.write(
  `  payload for ${key}: ${copied.length} files, ${(dirSize(outDir) / 1024 / 1024).toFixed(1)} MB -> ${outDir}\n` +
    `  node ${manifest.version}, better-sqlite3 ${payload.native['better-sqlite3'].version}\n`,
);
