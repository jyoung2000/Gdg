import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ask, type Askable } from '../../apps/cli/src/prompt.js';

/**
 * Asking for a credential at a terminal.
 *
 * `uag configure` reads an API key. Whatever readline would have echoed while
 * it is being typed must not reach the terminal, and an input stream that ends
 * before the answer must not look like an answer.
 */

/** A stand-in for `process.stdout` that remembers everything written to it. */
function capture(): NodeJS.WriteStream & { seen: () => string } {
  let text = '';
  const stream = {
    write(chunk: string): boolean {
      text += chunk;
      return true;
    },
    seen: () => text,
  };
  return stream as unknown as NodeJS.WriteStream & { seen: () => string };
}

/** A readline stand-in that echoes what is "typed", exactly as readline does. */
function typing(value: string, output: NodeJS.WriteStream): Askable {
  return {
    question: async (prompt: string) => {
      output.write(prompt);
      // readline redraws the line as each character arrives.
      for (const ch of value) output.write(ch);
      return value;
    },
    once: () => undefined,
    off: () => undefined,
  };
}

describe('Asking for a secret at the terminal', () => {
  it('does not let the answer reach the screen', async () => {
    const out = capture();
    const secret = 'sk-ant-should-never-be-displayed-0001';
    const answer = await ask(typing(secret, out), 'API key: ', { secret: true, output: out });

    assert.equal(answer, secret, 'the caller must still receive what was typed');
    assert.ok(!out.seen().includes(secret), `the key was echoed: ${JSON.stringify(out.seen())}`);
    assert.match(out.seen(), /API key: /, 'the prompt itself must still be shown');
  });

  it('shows an ordinary answer, because hiding a gateway URL helps nobody', async () => {
    const out = capture();
    const url = 'http://localhost:4639';
    await ask(typing(url, out), 'Gateway URL: ', { output: out });
    assert.ok(out.seen().includes(url), 'a non-secret answer should echo as usual');
  });

  it('leaves the stream working once the answer is in', async () => {
    const out = capture();
    await ask(typing('x', out), 'q: ', { secret: true, output: out });
    out.write('visible again');
    assert.match(out.seen(), /visible again/, 'the stream was left muted');
  });

  it('rejects when the input ends before an answer', async () => {
    // A piped `uag configure` used to exit 0 having saved nothing, because the
    // promise readline returns never settles when the stream closes first.
    const closed: Askable = {
      question: () => new Promise<string>(() => undefined),
      once: (_event, listener) => {
        setTimeout(listener, 0);
        return undefined;
      },
      off: () => undefined,
    };
    await assert.rejects(() => ask(closed, 'API key: ', { secret: true, output: capture() }), /input ended/);
  });
});
