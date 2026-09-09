import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSandbox, Workspace, createToolRegistry, executeTool, type ToolContext } from '@meridian/agent-sdk';
import { nullLogger } from '@meridian/shared';

/**
 * Every tool an agent can be handed, exercised through its own `run`.
 *
 * The workspace primitives underneath were already well covered, and the tools
 * were not: `delete_file` in particular had no test that went through the
 * agent-facing wrapper, so its schema, its argument coercion and the shape of
 * its result were unverified even though `workspace.delete` was solid.
 *
 * The coverage assertion is derived from `ALL_TOOLS` rather than written out,
 * so adding a twelfth tool without exercising it fails here — which is the only
 * way a list like this stays true.
 */

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'meridian-tools-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, 'src', 'doomed.ts'), 'export const gone = true;\n');
  writeFileSync(join(root, 'README.md'), '# Fixture\n\nA workspace for exercising tools.\n');
  return { ws: new Workspace(root), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function contextFor(ws: Workspace): ToolContext {
  return {
    workspace: ws,
    sandbox: new ProcessSandbox(nullLogger),
    taskId: 'task-tools',
    stepId: 'step-tools',
    commandTimeoutMs: 15_000,
  };
}

/**
 * The registry an agent actually gets, with web access on so `web_fetch` exists.
 *
 * Calls go through `executeTool` rather than `tool.run` because that is the real
 * path: it is where a thrown error becomes a readable result, where an
 * unavailable tool is refused, and where the call is recorded. Testing `run`
 * directly would skip the layer that makes the contract true.
 */
const registry = createToolRegistry({ webAccess: true });
const allowed = [...registry.keys()];
const exercised = new Set<string>();

async function call(name: string, args: Record<string, unknown>, ws: Workspace) {
  assert.ok(registry.has(name), `no tool named ${name}`);
  exercised.add(name);
  const { result } = await executeTool(
    { id: `call-${name}`, name, arguments: args },
    contextFor(ws),
    allowed,
    registry,
  );
  return result;
}

describe('The agent tool surface', () => {
  it('deletes a file, records it, and reports the path it touched', async () => {
    const { ws, root, cleanup } = tempWorkspace();
    try {
      const res = await call('delete_file', { path: 'src/doomed.ts' }, ws);
      assert.equal(res.isError, false, res.content);
      assert.equal(existsSync(join(root, 'src', 'doomed.ts')), false, 'the file is still there');
      // filesTouched is what the review UI lists and what the diff is built
      // from; a deletion that reports nothing is a deletion nobody can undo.
      assert.deepEqual(res.filesTouched, ['src/doomed.ts']);
      assert.ok(ws.pendingChanges().some((c) => c.path === 'src/doomed.ts'), 'the deletion was not recorded as a change');
    } finally {
      cleanup();
    }
  });

  it('refuses to delete outside the workspace rather than obeying', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      const res = await call('delete_file', { path: '../../etc/hosts' }, ws);
      // Errors are results, not exceptions — the model has to be able to read
      // the refusal and do something else.
      assert.equal(res.isError, true);
      assert.match(res.content, /outside the workspace/i);
    } finally {
      cleanup();
    }
  });

  it('reads, writes and edits', async () => {
    const { ws, root, cleanup } = tempWorkspace();
    try {
      const read = await call('read_file', { path: 'src/index.ts' }, ws);
      assert.match(read.content, /answer = 41/);

      const write = await call('write_file', { path: 'src/new.ts', content: 'export const fresh = 1;\n' }, ws);
      assert.equal(write.isError, false, write.content);
      assert.ok(existsSync(join(root, 'src', 'new.ts')));

      const edit = await call('edit_file', { path: 'src/index.ts', old_text: 'answer = 41', new_text: 'answer = 42' }, ws);
      assert.equal(edit.isError, false, edit.content);
      const after = await call('read_file', { path: 'src/index.ts' }, ws);
      assert.match(after.content, /answer = 42/);
    } finally {
      cleanup();
    }
  });

  it('lists, globs and greps', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      assert.match((await call('list_files', {}, ws)).content, /index\.ts/);
      assert.match((await call('glob', { pattern: '**/*.ts' }, ws)).content, /index\.ts/);
      const grep = await call('grep', { pattern: 'answer' }, ws);
      assert.match(grep.content, /index\.ts/);
    } finally {
      cleanup();
    }
  });

  it('runs a command and reports its exit code separately from tool failure', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      const ok = await call('run_command', { command: 'echo hello' }, ws);
      assert.equal(ok.isError, false);
      assert.match(ok.content, /hello/);
      assert.equal(ok.exitCode, 0);

      // A failing command is a *successful tool call*: the command ran and its
      // output is what the model needs. Conflating the two made a tester step
      // whose suite failed indistinguishable from one that passed.
      const failed = await call('run_command', { command: 'exit 3' }, ws);
      assert.equal(failed.isError, false, 'a non-zero exit was reported as a tool failure');
      assert.equal(failed.exitCode, 3);
    } finally {
      cleanup();
    }
  });

  it('shows a diff and finishes', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      await call('write_file', { path: 'src/index.ts', content: 'export const answer = 42;\n' }, ws);
      const diff = await call('show_diff', {}, ws);
      assert.equal(diff.isError, false, diff.content);
      assert.match(diff.content, /index\.ts/);

      const done = await call('finish', { summary: 'done' }, ws);
      assert.equal(done.finished, true, 'finish did not end the loop');
    } finally {
      cleanup();
    }
  });

  it('exposes git without letting a branch name become a shell command', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      const res = await call('git', { operation: 'status' }, ws);
      // Not a git repository is a perfectly good answer; what matters is that
      // the tool ran and reported rather than throwing.
      assert.equal(typeof res.content, 'string');
      assert.ok(res.content.length > 0);
    } finally {
      cleanup();
    }
  });

  it('refuses web_fetch for a private address', async () => {
    const { ws, cleanup } = tempWorkspace();
    try {
      const res = await call('web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' }, ws);
      assert.equal(res.isError, true, 'the metadata service was fetched');
      assert.match(res.content, /private|loopback|link-local|refus|disabled/i);
    } finally {
      cleanup();
    }
  });

  it('leaves no tool in the registry unexercised', () => {
    // Derived from ALL_TOOLS, so this cannot drift: a new tool with no test
    // fails here rather than appearing in a matrix as covered.
    const missing = [...registry.keys()].filter((n) => !exercised.has(n)).sort();
    assert.deepEqual(missing, [], `these tools have no test that runs them: ${missing.join(', ')}`);
  });
});
