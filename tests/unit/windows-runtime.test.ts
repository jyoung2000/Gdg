import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shellFor } from '@meridian/agent-sdk';

/**
 * The parts of Meridian that assumed a Unix host.
 *
 * Each of these was found by auditing for a Windows desktop build, and each
 * would have shipped as "the gateway starts and then nothing works" rather than
 * as an error anyone could act on. They are tested here rather than on Windows
 * because the decision is a pure function of the platform, and a decision that
 * can only be checked by shipping it is not checked.
 */

describe('The shell that runs an agent’s commands', () => {
  it('uses /bin/sh everywhere that has one', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
      const [program, args] = shellFor('npm test', platform);
      assert.equal(program, '/bin/sh');
      assert.deepEqual(args, ['-lc', 'npm test']);
    }
  });

  it('does not ask Windows for /bin/sh', () => {
    // `spawn('/bin/sh')` on Windows raises ENOENT, and the gateway reports it
    // as "Failed to start command". Every build, every test run, every
    // `git commit` and every clone into a new workspace failed that way — with
    // the gateway itself running fine, so nothing at startup explained it.
    const [program] = shellFor('npm test', 'win32');
    assert.notEqual(program, '/bin/sh');
    assert.ok(program.length > 0);
  });

  it('prefers a POSIX shell on Windows, because the commands it runs are POSIX', () => {
    // Meridian composes `git add -A && git commit -m '...'` with single-quoted
    // arguments. `cmd.exe` understands neither that quoting nor, reliably, the
    // `&&` — so choosing it would trade one failure for a subtler one.
    const [program, args] = shellFor("git add -A && git commit -m 'wip'", 'win32');
    if (program.toLowerCase().endsWith('bash.exe')) {
      assert.deepEqual(args, ['-lc', "git add -A && git commit -m 'wip'"]);
    } else {
      // No Git for Windows on this machine. The fallback is cmd, and the
      // command is passed through whole rather than being mangled — it will
      // fail on its own quoting, which is a better failure than failing to
      // start a shell at all.
      assert.match(program.toLowerCase(), /cmd\.exe$/);
      assert.equal(args[0], '/d');
      assert.equal(args.at(-1), "git add -A && git commit -m 'wip'");
    }
  });

  it('passes the command through unchanged, whatever the shell', () => {
    // The command is the agent's. Rewriting it here would mean the model sees
    // one thing and the machine runs another.
    const command = 'pnpm build && node scripts/verify.mjs --strict';
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const [, args] = shellFor(command, platform);
      assert.ok(args.includes(command), `${platform} altered the command: ${args.join(' ')}`);
    }
  });
});
