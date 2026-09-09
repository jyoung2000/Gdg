import type { createInterface } from 'node:readline/promises';

/** Just enough of a readline interface to ask a question and know when it closes. */
export interface Askable {
  question(prompt: string): Promise<string>;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

export type PromptInterface = ReturnType<typeof createInterface>;

/**
 * Ask a question, and know when nobody answered.
 *
 * Two things `readline.question` does not do on its own.
 *
 * It never settles if the input ends first, so a closed stream left the caller
 * waiting on a promise that would not resolve and the process simply exited —
 * which is how `uag configure` came to report success while saving nothing.
 *
 * And it echoes every keystroke, which is right for a URL and wrong for a
 * credential: a key on screen is a key in a screen recording, in a screenshot
 * of a terminal, and on the monitor behind whoever is walking past. The
 * suppression works by silencing the stream readline writes to for the
 * duration of the answer, rather than by overriding readline's own private
 * writer — that private method is not there to override on current Node, and a
 * suppression that quietly stops working is worse than none, because nobody
 * looks at it again.
 */
export async function ask(rl: Askable, prompt: string, opts: { secret?: boolean; output?: NodeJS.WriteStream } = {}): Promise<string> {
  const stream = opts.output ?? process.stdout;
  const original = stream.write.bind(stream);
  if (opts.secret) {
    original(prompt);
    stream.write = (() => true) as typeof stream.write;
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      const onClose = (): void => reject(new Error('input ended'));
      rl.once('close', onClose);
      rl.question(opts.secret ? '' : prompt).then(
        (answer) => {
          rl.off('close', onClose);
          resolve(answer);
        },
        (e: unknown) => {
          rl.off('close', onClose);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  } finally {
    if (opts.secret) {
      stream.write = original;
      original('\n');
    }
  }
}
