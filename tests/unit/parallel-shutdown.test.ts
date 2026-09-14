import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '@meridian/agent-sdk';

/**
 * What shutdown can see, and when.
 *
 * `cancelAll` and `settle` work from what the orchestrator has registered. A
 * parallel run spends its first seconds copying a workspace per lane, before
 * any `run()` is called — so nothing was registered, shutdown looked, found
 * nothing, reported itself clean and closed the store. The lanes then started
 * against a database that was gone.
 *
 * `supervise` is the fix, and these drive it directly: the window between
 * "work has begun" and "a task is running" is exactly the window that used to
 * be invisible.
 */
describe('Supervised detached work', () => {
  /** The orchestrator with nothing wired: supervise touches none of its deps. */
  const bare = (): Orchestrator => new Orchestrator({} as never);

  it('is visible to shutdown before any task has started', async () => {
    const o = bare();
    let released = () => undefined as void;
    const started = new Promise<void>((r) => (released = r));

    const work = o.supervise('lanes_1', async () => {
      await started;
      return 'done';
    });

    assert.deepEqual(o.runningTaskIds(), ['lanes_1'], 'supervised work must be visible the moment it begins');
    released();
    assert.equal(await work, 'done');
    assert.deepEqual(o.runningTaskIds(), [], 'and must deregister when it finishes');
  });

  it('is cancelled by cancelAll, and cancelling actually reaches it', async () => {
    const o = bare();
    let sawAbort = false;
    const work = o.supervise('lanes_2', async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve());
      });
      sawAbort = signal.aborted;
      return 'stopped';
    });

    assert.equal(o.cancelAll(), 1, 'cancelAll must find it');
    assert.equal(await work, 'stopped');
    assert.equal(sawAbort, true, 'the signal must actually reach the work, not merely be recorded');
  });

  it('is waited for by settle', async () => {
    const o = bare();
    let finished = false;
    const work = o.supervise('lanes_3', async () => {
      // Deliberately NOT unref'd: this timer is the thing settle must wait
      // for, and a timer that cannot hold the loop open proves nothing.
      await new Promise<void>((r) => setTimeout(r, 120));
      finished = true;
    });

    assert.equal(await o.settle(5_000), true, 'settle must wait rather than resolve past it');
    assert.equal(finished, true, 'and the work must really be over when it returns');
    await work;
  });

  it('deregisters even when the work throws', async () => {
    const o = bare();
    await assert.rejects(
      o.supervise('lanes_4', async () => {
        throw new Error('lane exploded');
      }),
      /lane exploded/,
    );
    assert.deepEqual(o.runningTaskIds(), [], 'a failure must not leave the run registered forever');
    assert.equal(await o.settle(100), true, 'and must not hold shutdown open');
  });
});
