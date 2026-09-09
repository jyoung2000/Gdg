#!/usr/bin/env node
/**
 * The portable build: the same application, in a folder, with no installer.
 *
 * Some people cannot run an installer — a locked-down work machine, a shared
 * computer, a policy against writing to the registry — and some simply prefer
 * not to. The portable build is for them. It is not a different product: it is
 * the same executable and the same payload the installer would have laid down,
 * arranged the way the executable already looks for them.
 *
 *   Meridian-Portable-x64/
 *     Meridian.exe          the shell
 *     runtime/node.exe      the pinned Node, verified by digest at build time
 *     server/               the gateway, the web client, the migrations
 *     payload.json          what this is and what it was built from
 *     README.txt            the two things that differ from an install
 *
 * `find_payload` in the shell checks the executable's own directory, so this
 * layout needs no special case in the application.
 *
 *   node scripts/package-portable.mjs --platform win32 --arch x64
 *
 * The zip is written here rather than shelled out to `zip` or `Compress-Archive`
 * so that the same code produces the archive on every platform, and so that
 * this script can be exercised on the machine that develops it rather than only
 * on the machine that releases it.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`\npackage-portable: ${message}\n\n`);
  process.exit(1);
}

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const platform = flag('platform', process.platform);
const arch = flag('arch', process.arch);
const payloadDir = resolve(flag('payload', join(ROOT, 'apps/desktop/payload')));
const outDir = resolve(flag('out', join(ROOT, 'dist/portable')));

if (!existsSync(join(payloadDir, 'payload.json'))) {
  fail(`no payload at ${payloadDir}. Run scripts/package-desktop.mjs first.`);
}
const payload = JSON.parse(readFileSync(join(payloadDir, 'payload.json'), 'utf8'));
if (payload.platform !== platform || payload.arch !== arch) {
  fail(
    `the payload is for ${payload.platform}-${payload.arch}, not ${platform}-${arch}.\n` +
      '  A portable build that carries another platform’s binaries starts and then fails at require().'
  );
}

/* ------------------------------------------------------------------ */
/* Find the shell binary Tauri built                                   */
/* ------------------------------------------------------------------ */

const exeName = platform === 'win32' ? 'Meridian.exe' : 'Meridian';
const built = [
  flag('binary'),
  join(ROOT, 'apps/desktop/src-tauri/target/release', platform === 'win32' ? 'meridian.exe' : 'meridian'),
  join(ROOT, 'apps/desktop/src-tauri/target/release', exeName),
]
  .filter(Boolean)
  .find((p) => existsSync(p));

if (!built) {
  fail(
    'the desktop shell has not been built.\n' +
      '  Run `pnpm exec tauri build --config apps/desktop/src-tauri/tauri.conf.json` first,\n' +
      '  or pass --binary <path> if it is somewhere else.'
  );
}

/* ------------------------------------------------------------------ */
/* A zip writer, because this needs to work the same everywhere        */
/* ------------------------------------------------------------------ */

/**
 * Zip timestamps are MS-DOS, and Meridian's builds are meant to be comparable
 * between runs. A fixed timestamp makes the archive a function of its contents:
 * build the same payload twice and the bytes match, so a difference in a
 * published archive means a difference in what is inside it.
 */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01

function zipEntry(name, data) {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  // A file that deflates larger than it started (already-compressed data, and
  // node.exe is full of it) is stored instead.
  const deflated = compressed.length < data.length;
  return {
    name: nameBytes,
    crc: crc32(data),
    method: deflated ? 8 : 0,
    body: deflated ? compressed : data,
    size: data.length,
  };
}

function localHeader(entry) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(entry.method, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.body.length, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, entry.name]);
}

function centralHeader(entry, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(0x031e, 4); // made by: UNIX, zip 3.0 — carries the mode below
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.body.length, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk
  head.writeUInt16LE(0, 36); // internal attrs
  // The executable bit, for anyone unzipping this on a machine that has one.
  // Windows ignores it; macOS and Linux do not, and a runtime without +x is a
  // build that unpacks and then cannot start.
  head.writeUInt32LE((((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0), 38);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, entry.name]);
}

function writeZip(path, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const entry = zipEntry(file.name, file.data);
    entry.executable = file.executable === true;
    const local = localHeader(entry);
    chunks.push(local, entry.body);
    central.push(centralHeader(entry, offset));
    offset += local.length + entry.body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const buffer = Buffer.concat([...chunks, directory, end]);
  writeFileSync(path, buffer);
  return buffer.length;
}

/* ------------------------------------------------------------------ */
/* Collect what goes in                                                */
/* ------------------------------------------------------------------ */

const folder = `Meridian-Portable-${arch}`;
const files = [];

function add(archivePath, absolutePath, executable = false) {
  files.push({ name: `${folder}/${archivePath}`, data: readFileSync(absolutePath), executable });
}

function walk(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else add(rel, full, (statSync(full).mode & 0o111) !== 0);
  }
}

add(exeName, built, true);
walk(join(payloadDir, 'runtime'), 'runtime');
walk(join(payloadDir, 'server'), 'server');
add('payload.json', join(payloadDir, 'payload.json'));

const readme = `Meridian ${payload.version} — portable
${'='.repeat(40)}

Run ${exeName}. Nothing is installed and nothing is written to the registry.

Two things differ from the installed build:

1. Your data still lives in your user profile, not in this folder.
   ${platform === 'win32' ? '%APPDATA%\\\\Meridian' : '~/.local/share/Meridian'}
   Deleting this folder does not delete your database or your credentials, and
   copying this folder to another machine does not carry them with it. That is
   deliberate: credentials are encrypted under a key the operating system holds
   for your account, and a key that travelled on a USB stick would not be
   protecting anything.

2. ${
    platform === 'win32'
      ? 'It needs the Microsoft Edge WebView2 runtime, which Windows 11 and\n   up-to-date Windows 10 already have. The installer would put it there if it\n   were missing; this archive cannot. If Meridian reports that WebView2 is\n   missing, install it from Microsoft and run Meridian again.'
      : 'It needs a system WebKitGTK, which most desktop distributions have.'
  }

Everything else is the same application: the same gateway, the same bundled
Node ${payload.node.version}, the same database format.

Verify this archive against the SHA256SUMS.txt published with the release
before you run it.
`;
files.push({ name: `${folder}/README.txt`, data: Buffer.from(readme, 'utf8') });

/* ------------------------------------------------------------------ */
/* Write it                                                            */
/* ------------------------------------------------------------------ */

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `Meridian-Portable-${arch}.zip`);
rmSync(zipPath, { force: true });
const bytes = writeZip(zipPath, files);

const uncompressed = files.reduce((n, f) => n + f.data.length, 0);
process.stdout.write(
  `  portable ${platform}-${arch}: ${files.length} files, ` +
    `${(uncompressed / 1024 / 1024).toFixed(1)} MB -> ${(bytes / 1024 / 1024).toFixed(1)} MB\n` +
    `  ${zipPath}\n`
);
