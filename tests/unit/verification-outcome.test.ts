import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCommandTool } from '@meridian/agent-sdk';
import type { Sandbox } from '@meridian/agent-sdk';

/**
 * A failing test suite has to be a fact the system can act on.
 *
 * The old behaviour was subtle and wrong in the worst direction. A command that
 * exits non-zero comes back as `isError: false` — correctly, because the model
 * needs to read the failure and debug rather than retry the tool — and then
 * nothing else in the pipeline looked at it. The tester step was written down
 * as `completed`, the reviewer was told nothing, and the task reported success.
 * A run where the tests did not pass was indistinguishable from one where they
 * did.
 */

function sandboxReturning(exitCode: number, stdout = ''): Sandbox {
  return {
    kind: 'process',
    isolationSummary: 'test double',
    exec: async () => ({ stdout, stderr: exitCode === 0 ? '' : 'FAIL tests/a.test.ts', exitCode, timedOut: false, truncated: false }),
  } as unknown as Sandbox;
}

const ctx = (sandbox: Sandbox) =>
  ({
    workspace: {} as never,
    sandbox,
    taskId: 't1',
    stepId: 's1',
    commandTimeoutMs: 5000,
  }) as never;

describe('A command result carries its exit code', () => {
  it('reports a failing command as a successful tool call that failed', async () => {
    const result = await runCommandTool.run({ command: 'npm test' }, ctx(sandboxReturning(1)));

    // Both halves matter, and they say different things.
    assert.equal(result.isError, false, 'the tool worked: it ran the command and got output the model can debug from');
    assert.equal(result.exitCode, 1, 'and the command did not succeed, which the orchestrator has to be able to see');
    assert.match(result.content, /exit code: 1/);
  });

  it('reports a passing command as exit code zero', async () => {
    const result = await runCommandTool.run({ command: 'npm test' }, ctx(sandboxReturning(0, 'ok')));
    assert.equal(result.isError, false);
    assert.equal(result.exitCode, 0);
  });

  it('distinguishes a failed command from a failed tool', async () => {
    // A tool that could not run at all is a different thing from a command that
    // ran and returned non-zero, and conflating them is why a failing suite
    // used to look like a passing one.
    const failing = await runCommandTool.run({ command: 'npm test' }, ctx(sandboxReturning(1)));
    const passing = await runCommandTool.run({ command: 'npm test' }, ctx(sandboxReturning(0)));
    assert.notEqual(failing.exitCode, passing.exitCode);
    assert.equal(failing.isError, passing.isError, 'neither is a tool failure');
  });
});
