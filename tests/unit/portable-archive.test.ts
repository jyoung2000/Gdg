import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const payloadDir = join(ROOT, 'apps/desktop/payload');
const hasPayload = existsSync(join(payloadDir, 'payload.json'));

/**
 * The portable archive is a zip this repository writes itself, rather than one
 * `zip` or `Compress-Archive` produced. That is worth the ~100 lines because
 * the archive is then identical on every platform — but it also means the
 * format is Meridian's problem, and a zip that Windows Explorer silently
 * refuses to open is not a failure anyone would see before a release.
 *
 * So this reads the archive back with a different implementation than the one
 * that wrote it: the system `unzip`, which is the same code path a user's
 * extractor takes. A round trip through the writer alone would prove nothing.
 */
describe('The portable archive', { skip: !hasPayload ? 'no payload assembled; run pnpm build:desktop' : false }, () => {
  const payload = hasPayload ? JSON.parse(readFileSync(join(payloadDir, 'payload.json'), 'utf8')) : null;

  let dir = '';
  let zip = '';
  let unpacked = '';

  before(() => {
    if (!hasPayload) return;
    dir = mkdtempSync(join(tmpdir(), 'meridian-portable-'));
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/package-portable.mjs'),
        '--platform',
        payload.platform,
        '--arch',
        payload.arch,
        '--out',
        dir,
        // The shell binary is Rust and may not have been built here; the
        // archive's structure does not depend on which file this is.
        '--binary',
        join(ROOT, 'package.json'),
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    zip = join(dir, `Meridian-Portable-${payload.arch}.zip`);
    unpacked = join(dir, 'unpacked', `Meridian-Portable-${payload.arch}`);
    execFileSync('unzip', ['-q', zip, '-d', join(dir, 'unpacked')]);
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('is a zip that a different implementation can read', () => {
    assert.ok(existsSync(zip), 'no archive was produced');
    let unzip: string;
    try {
      unzip = execFileSync('unzip', ['-t', zip], { encoding: 'utf8' });
    } catch (error) {
      // No `unzip` on this machine. Say so rather than passing quietly: a
      // skipped integrity check reads exactly like a successful one.
      assert.fail(`could not verify the archive with an external reader: ${(error as Error).message}`);
    }
    assert.match(unzip, /No errors detected/);
  });

  it('unpacks into one folder holding a whole application', () => {
    // Everything the shell's find_payload looks for, in the layout it looks
    // for it in. A portable build that unpacks and cannot find its own gateway
    // is the failure this guards.
    for (const rel of [payload.node.binary, payload.server.entry, 'server/web/index.html', 'payload.json', 'README.txt']) {
      assert.ok(existsSync(join(unpacked, rel)), `missing from the archive: ${rel}`);
    }
    assert.ok(existsSync(join(unpacked, payload.server.migrations)), 'the migrations are missing');
  });

  it('keeps the executable bit on the runtime', () => {
    // Windows does not have one, but the archive is written once and read on
    // whatever the user has. A runtime without +x unpacks fine and then cannot
    // start, which looks like a corrupt download rather than a packaging bug.
    const node = join(unpacked, payload.node.binary);
    assert.ok((statSync(node).mode & 0o111) !== 0, 'the bundled runtime is not executable after unpacking');
  });

  it('refuses to package a payload built for another platform', () => {
    // The failure it prevents: an archive that installs perfectly and then
    // fails at require() because it carries the wrong native binaries.
    const other = payload.platform === 'win32' ? 'linux' : 'win32';
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [join(ROOT, 'scripts/package-portable.mjs'), '--platform', other, '--arch', payload.arch],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
        ),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /the payload is for/);
        return true;
      },
    );
  });

  it('says what a portable build does not do', () => {
    const readme = readFileSync(join(unpacked, 'README.txt'), 'utf8');
    // The two things that surprise people: their data is not in the folder,
    // and the archive cannot install the system web runtime the window needs.
    assert.match(readme, /does not delete your database/);
    assert.match(readme, /WebView2|WebKitGTK/);
  });
});
