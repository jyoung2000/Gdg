import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleTo, EventBus } from '../../apps/gateway/src/services/events.js';
import { nullLogger } from '@meridian/shared';

/**
 * Who sees a live event.
 *
 * The bus carries prompts, model output, spend and — through task diffs — the
 * actual contents of files an agent wrote. `userId: null` is the
 * everyone-audience, correct for instance-wide facts like a discovery pass or
 * a model retirement, and catastrophic as a *fallback*: any event the
 * attribution logic could not resolve took that path and went to every
 * connected client.
 */
describe('Event audience', () => {
  const alice = { userId: 'usr_alice', admin: false };
  const bob = { userId: 'usr_bob', admin: false };
  const operator = { userId: 'usr_admin', admin: true };
  const anonymous = { userId: null, admin: false };

  it('shows an instance-wide event to everyone', () => {
    for (const viewer of [alice, bob, operator, anonymous]) {
      assert.equal(visibleTo({ userId: null }, viewer), true);
    }
  });

  it('shows an owned event to its owner and to an administrator, and to nobody else', () => {
    const mine = { userId: 'usr_alice' };
    assert.equal(visibleTo(mine, alice), true);
    assert.equal(visibleTo(mine, operator), true, 'an administrator sees the instance, which is the job');
    assert.equal(visibleTo(mine, bob), false);
    assert.equal(visibleTo(mine, anonymous), false);
  });

  it('withholds an event that could not be attributed, rather than broadcasting it', () => {
    // The fail-closed default. Everything on the task channel carries someone's
    // work, so an event whose owner cannot be resolved goes to administrators
    // and no further.
    const unknown = { userId: null, adminOnly: true };
    assert.equal(visibleTo(unknown, operator), true);
    assert.equal(visibleTo(unknown, alice), false);
    assert.equal(visibleTo(unknown, bob), false);
    assert.equal(
      visibleTo(unknown, anonymous),
      false,
      'an unattributable event must not reach an unauthenticated listener',
    );
  });

  it('delivers over the bus exactly as visibleTo decides', () => {
    const bus = new EventBus(nullLogger);
    const seen: Record<string, number> = { alice: 0, bob: 0, operator: 0 };
    bus.subscribe(() => (seen.alice += 1), alice);
    bus.subscribe(() => (seen.bob += 1), bob);
    bus.subscribe(() => (seen.operator += 1), operator);

    const diff = {
      type: 'task' as const,
      event: { type: 'diff' as const, taskId: 'tsk_1', changes: [] },
    };
    bus.publish(diff, { userId: 'usr_alice' });
    assert.deepEqual(seen, { alice: 1, bob: 0, operator: 1 }, "Bob must not receive Alice's file changes");

    bus.publish(diff, { userId: null, adminOnly: true });
    assert.deepEqual(seen, { alice: 1, bob: 0, operator: 2 }, 'an unattributable diff reaches administrators only');

    bus.publish({ type: 'notice', level: 'info', message: 'discovery finished' });
    assert.deepEqual(seen, { alice: 2, bob: 1, operator: 3 }, 'an instance-wide notice still reaches everyone');
    bus.close();
  });
});
