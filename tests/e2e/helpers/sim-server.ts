import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';

export interface SimServer {
  /** Root URL, without the `/v1` suffix — what MERIDIAN_LOCAL_ENDPOINTS takes. */
  root: string;
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

const SCRIPT = resolve(process.cwd(), 'scripts/local-model-server.mjs');

/**
 * Start the local inference server as a real child process on an ephemeral port.
 *
 * Spawning it rather than importing it is the whole point: these tests have to
 * cross a socket, a process boundary and the HTTP stack, because that is where
 * streaming, cancellation and timeout bugs live. An in-process fake would skip
 * exactly the layer under test.
 */
export function startSimServer(args: string[] = []): Promise<SimServer> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      [SCRIPT, '--port', '0', '--chunk-ms', '0', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`local-model-server did not report a port in time: ${out}`));
    }, 15_000);
    timer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const match = out.match(/http:\/\/([\d.]+):(\d+)\/v1/);
      if (!match) return;
      clearTimeout(timer);
      const port = Number(match[2]);
      const root = `http://${match[1]}:${port}`;
      resolvePromise({
        root,
        baseUrl: `${root}/v1`,
        port,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.kill('SIGKILL');
          }),
      });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`local-model-server exited early (${code}): ${out}`));
    });
  });
}
