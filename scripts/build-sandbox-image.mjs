#!/usr/bin/env node
/**
 * Build the image agent commands run inside.
 *
 * Two modes:
 *
 *   (default)   docker build -f docker/Dockerfile.sandbox — the real image,
 *               with node, git, python and a build toolchain. Needs registry
 *               access for its base layer.
 *
 *   --offline   Assemble a minimal root filesystem from binaries already on
 *               this machine and `docker import` it. No network at all. The
 *               result carries a shell and a handful of utilities and NOTHING
 *               ELSE — it exists so the sandbox's isolation flags can be
 *               verified where a registry is unreachable. It is not a
 *               substitute for the real image and must never be used to run
 *               real agent commands: tag it separately and say so.
 *
 * Usage:
 *   node scripts/build-sandbox-image.mjs [--offline] [--tag meridian-sandbox:latest]
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex >= 0 && process.argv[tagIndex + 1] ? process.argv[tagIndex + 1] : offline ? 'meridian-sandbox:offline-test' : 'meridian-sandbox:latest';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

if (!offline) {
  process.stdout.write(`Building ${tag} from docker/Dockerfile.sandbox\n`);
  run('docker', ['build', '-f', join(root, 'docker/Dockerfile.sandbox'), '-t', tag, root]);
  process.exit(0);
}

/* ---- Offline mode ------------------------------------------------- */

// A shell plus enough utilities to observe the container's own constraints.
// Anything not found is skipped: the point is a working shell, not a distro.
const WANTED = [
  '/bin/dash', '/bin/sh', '/bin/cat', '/bin/ls', '/bin/pwd', '/bin/mkdir', '/bin/touch',
  '/bin/rm', '/bin/uname', '/bin/sleep', '/bin/grep', '/usr/bin/id', '/usr/bin/env',
  '/usr/bin/head', '/usr/bin/wc', '/usr/bin/tr', '/usr/bin/cut',
];

const stage = join(tmpdir(), `meridian-sandbox-rootfs-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
for (const dir of ['bin', 'lib', 'lib64', 'usr/bin', 'usr/lib', 'tmp', 'work', 'etc']) {
  mkdirSync(join(stage, dir), { recursive: true });
}

const libs = new Set();
const copied = [];
for (const bin of WANTED) {
  if (!existsSync(bin)) continue;
  const dest = join(stage, bin.replace(/^\//, ''));
  mkdirSync(dirname(dest), { recursive: true });
  // copyFileSync on the resolved target: cpSync refuses a path whose parent is
  // itself a symlinked directory, which /bin is on most distributions.
  copyFileSync(realpathSync(bin), dest);
  copied.push(bin);
  let out = '';
  try {
    out = run('ldd', [bin], { quiet: true, stdio: 'pipe' });
  } catch {
    continue; // Statically linked, or not a dynamic executable.
  }
  for (const match of out.matchAll(/(\/[^\s]+\.so[^\s]*)/g)) libs.add(match[1]);
}

if (!copied.length) {
  process.stderr.write('No usable binaries found on this host; offline mode needs a Linux userland.\n');
  process.exit(1);
}

for (const lib of libs) {
  if (!existsSync(lib)) continue;
  const dest = join(stage, lib.replace(/^\//, ''));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(realpathSync(lib), dest);
}

// /bin/sh has to exist even when the host's is a symlink we dereferenced.
if (!existsSync(join(stage, 'bin/sh'))) symlinkSync('dash', join(stage, 'bin/sh'));

// A named unprivileged account, so the container can run as one.
writeFileSync(join(stage, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/sh\nrunner:x:1002:1002:runner:/work:/bin/sh\n');
writeFileSync(join(stage, 'etc/group'), 'root:x:0:\nrunner:x:1002:\n');

const tarball = `${stage}.tar`;
run('tar', ['-cf', tarball, '-C', stage, '.']);
run('docker', ['import', '-c', 'CMD ["/bin/sh"]', '-c', 'WORKDIR /work', '-c', 'USER 1002:1002', tarball, tag]);
rmSync(stage, { recursive: true, force: true });
rmSync(tarball, { force: true });

process.stdout.write(
  `\nBuilt ${tag} from ${copied.length} host binaries and ${libs.size} shared libraries.\n` +
    'This image is for verifying sandbox isolation only. It has no toolchain and must not be used to run real agent commands.\n',
);
