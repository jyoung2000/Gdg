import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMeridianError } from '@meridian/shared';
import { Workspace, countDiff, globToRegExp, unifiedDiff, isBinaryPath } from '@meridian/agent-sdk';

function tempWorkspace(): { ws: Workspace; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'meridian-ws-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(root, 'src', 'util.ts'), 'export function noop(): void {}\n');
  writeFileSync(join(root, 'README.md'), '# Project\n');
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
  return { ws: new Workspace(root), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('Workspace containment', () => {
  it('refuses to resolve a path outside the root', () => {
    const { ws, cleanup } = tempWorkspace();
    for (const attempt of ['../secrets', '../../etc/passwd', 'src/../../outside', '/etc/passwd']) {
      // A leading slash is treated as workspace-relative, so only the genuine
      // escapes should throw.
      if (attempt.startsWith('/')) {
        assert.doesNotThrow(() => ws.absolute(attempt));
        continue;
      }
      assert.throws(() => ws.absolute(attempt), (e: unknown) => isMeridianError(e) && /outside the workspace/.test(e.message), attempt);
    }
    cleanup();
  });

  it('does not let a sibling directory with a shared prefix pass as inside', () => {
    const { ws, cleanup } = tempWorkspace();
    assert.throws(() => ws.absolute('../' + ws.root.split('/').pop() + '-other/file'));
    cleanup();
  });

  it('refuses to read binaries and oversized files', async () => {
    const { ws, root, cleanup } = tempWorkspace();
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(() => ws.read('logo.png'), (e: unknown) => isMeridianError(e) && /binary/.test(e.message));

    writeFileSync(join(root, 'huge.txt'), 'x'.repeat(600 * 1024));
    await assert.rejects(() => ws.read('huge.txt'), (e: unknown) => isMeridianError(e) && /read limit/.test(e.message));
    cleanup();
  });

  it('detects a binary file that has no telltale extension', async () => {
    const { ws, root, cleanup } = tempWorkspace();
    writeFileSync(join(root, 'data.bin2'), Buffer.from([0x41, 0x00, 0x42, 0x00]));
    await assert.rejects(() => ws.read('data.bin2'), (e: unknown) => isMeridianError(e) && /binary/.test(e.message));
    cleanup();
  });
});

describe('Workspace edits', () => {
  it('records the previous content so a change can be undone exactly', async () => {
    const { ws, cleanup } = tempWorkspace();
    const before = await ws.read('src/index.ts');

    await ws.write('src/index.ts', 'export const a = 99;\n');
    assert.equal(await ws.read('src/index.ts'), 'export const a = 99;\n');

    await ws.reject('src/index.ts');
    assert.equal(await ws.read('src/index.ts'), before, 'rejecting must restore the original byte-for-byte');
    cleanup();
  });

  it('removes a file that the agent created when the change is rejected', async () => {
    const { ws, cleanup } = tempWorkspace();
    await ws.write('src/new.ts', 'export const x = 1;\n');
    assert.equal(await ws.exists('src/new.ts'), true);

    await ws.reject('src/new.ts');
    assert.equal(await ws.exists('src/new.ts'), false);
    cleanup();
  });

  it('restores a deleted file when the deletion is rejected', async () => {
    const { ws, cleanup } = tempWorkspace();
    const before = await ws.read('README.md');
    await ws.delete('README.md');
    assert.equal(await ws.exists('README.md'), false);

    await ws.reject('README.md');
    assert.equal(await ws.read('README.md'), before);
    cleanup();
  });

  it('refuses an ambiguous edit rather than guessing which match to change', async () => {
    const { ws, cleanup } = tempWorkspace();
    await ws.write('dup.ts', 'const x = 1;\nconst x = 1;\n');

    await assert.rejects(
      () => ws.edit('dup.ts', 'const x = 1;', 'const x = 2;'),
      (e: unknown) => isMeridianError(e) && /appears 2 times/.test(e.message),
    );
    // With replace_all the intent is explicit, so it proceeds.
    await ws.edit('dup.ts', 'const x = 1;', 'const x = 2;', true);
    assert.equal(await ws.read('dup.ts'), 'const x = 2;\nconst x = 2;\n');
    cleanup();
  });

  it('reports when the anchor text is not present', async () => {
    const { ws, cleanup } = tempWorkspace();
    await assert.rejects(
      () => ws.edit('src/index.ts', 'nonexistent anchor', 'x'),
      (e: unknown) => isMeridianError(e) && /was not found/.test(e.message),
    );
    cleanup();
  });

  it('keeps the original across several edits to the same file', async () => {
    const { ws, cleanup } = tempWorkspace();
    const original = await ws.read('src/index.ts');
    await ws.write('src/index.ts', 'v2');
    await ws.write('src/index.ts', 'v3');

    assert.equal(ws.changeFor('src/index.ts')?.before, original, 'the baseline must be the pre-task content, not the last write');
    await ws.reject('src/index.ts');
    assert.equal(await ws.read('src/index.ts'), original);
    cleanup();
  });
});

describe('Workspace search', () => {
  it('excludes dependency and build directories from listings', async () => {
    const { ws, cleanup } = tempWorkspace();
    const files = await ws.listFiles();
    assert.ok(files.includes('src/index.ts'));
    assert.equal(files.some((f) => f.includes('node_modules')), false);
    cleanup();
  });

  it('globs across directories', async () => {
    const { ws, cleanup } = tempWorkspace();
    assert.deepEqual((await ws.glob('src/*.ts')).sort(), ['src/index.ts', 'src/util.ts']);
    assert.ok((await ws.glob('**/*.md')).includes('README.md'));
    cleanup();
  });

  it('greps with line numbers and reports a bad pattern clearly', async () => {
    const { ws, cleanup } = tempWorkspace();
    const hits = await ws.grep('export const');
    assert.ok(hits.some((h) => h.path === 'src/index.ts' && h.line === 1));

    await assert.rejects(() => ws.grep('([unclosed'), (e: unknown) => isMeridianError(e) && /Invalid search pattern/.test(e.message));
    cleanup();
  });
});

describe('Diff', () => {
  it('counts additions and deletions', () => {
    assert.deepEqual(countDiff('a\nb\nc', 'a\nb\nc'), { additions: 0, deletions: 0 });
    assert.deepEqual(countDiff('a\nb', 'a\nb\nc'), { additions: 1, deletions: 0 });
    assert.deepEqual(countDiff('a\nb\nc', 'a\nc'), { additions: 0, deletions: 1 });
    assert.deepEqual(countDiff('', 'a\nb'), { additions: 2, deletions: 0 });
  });

  it('produces a unified diff with hunk headers', () => {
    const diff = unifiedDiff('f.ts', 'one\ntwo\nthree\nfour\nfive\n', 'one\ntwo\nCHANGED\nfour\nfive\n');
    assert.match(diff, /^--- a\/f\.ts/m);
    assert.match(diff, /^\+\+\+ b\/f\.ts/m);
    assert.match(diff, /^@@ /m);
    assert.match(diff, /^-three$/m);
    assert.match(diff, /^\+CHANGED$/m);
  });

  it('handles creation and deletion', () => {
    assert.match(unifiedDiff('n.ts', null, 'hello\n'), /^\+hello$/m);
    assert.match(unifiedDiff('d.ts', 'gone\n', null), /^-gone$/m);
  });
});

describe('Glob translation', () => {
  it('maps glob syntax onto anchored regular expressions', () => {
    assert.equal(globToRegExp('*.ts').test('index.ts'), true);
    assert.equal(globToRegExp('*.ts').test('src/index.ts'), false, 'a single star must not cross a directory');
    assert.equal(globToRegExp('**/*.ts').test('a/b/c.ts'), true);
    assert.equal(globToRegExp('**/*.ts').test('c.ts'), true, '**/ must be able to match zero directories');
    assert.equal(globToRegExp('src/?.ts').test('src/a.ts'), true);
    assert.equal(globToRegExp('src/?.ts').test('src/ab.ts'), false);
    // Regex metacharacters in a glob are literals.
    assert.equal(globToRegExp('a+b.ts').test('a+b.ts'), true);
    assert.equal(globToRegExp('a+b.ts').test('aab.ts'), false);
  });

  it('recognises binary extensions', () => {
    assert.equal(isBinaryPath('a/b/logo.PNG'), true);
    assert.equal(isBinaryPath('a/b/index.ts'), false);
  });
});
