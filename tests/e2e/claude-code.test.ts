import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

const exec = promisify(execFile);

/**
 * Claude Code, the real client, driven through Meridian's Anthropic surface.
 *
 * This is a different claim from "the Anthropic endpoint passes its tests". A
 * real coding agent sends a system prompt as an array of blocks, forty-one tool
 * definitions, `metadata`, `output_config`, `thinking` and `context_management`
 * keys, a `?beta=true` query string, and it expects streamed `tool_use` blocks
 * it can execute and answer with `tool_result`. Any one of those can be dropped
 * or mistranslated by a gateway whose own tests all pass.
 *
 * What this verifies is the protocol: Claude Code connects, Meridian routes,
 * tools survive the translation in both directions, a multi-turn loop completes,
 * and the tool calls have real effects on disk. It does not verify that a model
 * does good work through Meridian — the inference server here is deterministic
 * and rule-based, and no provider credential exists in this environment.
 *
 * Skips, with the reason printed, when the `claude` binary is absent.
 */
describe('Claude Code through Meridian', async () => {
  let claudeAvailable = false;
  try {
    await exec('claude', ['--version'], { timeout: 30_000 });
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
  }
  const skip = claudeAvailable ? false : 'the `claude` CLI is not installed in this environment';

  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let home: string;
  let project: string;
  let base: string;

  before(async () => {
    if (skip) return;
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-cc-'));
    // Claude Code writes its own configuration and history; give it somewhere
    // that is not the developer's home directory.
    home = mkdtempSync(join(tmpdir(), 'meridian-cc-home-'));
    project = mkdtempSync(join(tmpdir(), 'meridian-cc-project-'));
    writeFileSync(join(project, 'README.md'), '# Fixture project\n');
    writeFileSync(join(project, 'index.js'), 'export const answer = 42;\n');

    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'cc.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'claude-code-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    for (const dir of [dataDir, home, project]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  interface ClaudeResult {
    num_turns: number;
    is_error: boolean;
    stop_reason: string;
    result: string;
    usage?: { input_tokens: number; output_tokens: number };
  }

  /** Run Claude Code non-interactively against Meridian and parse its JSON result. */
  const run = async (prompt: string, extra: string[] = []): Promise<ClaudeResult> => {
    const { stdout } = await exec(
      'claude',
      ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', ...extra, prompt],
      {
        cwd: project,
        timeout: 240_000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: home,
          ANTHROPIC_BASE_URL: `${base}/anthropic`,
          ANTHROPIC_API_KEY: 'meridian-local',
          // The gateway's own model, not an Anthropic one — the point is that a
          // client can be pointed at whatever capacity Meridian actually has.
          ANTHROPIC_MODEL: 'meridian-sim-chat',
          // The client's context-window catalog does not know this model, and
          // the warning it prints otherwise is noise here.
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
          NO_PROXY: '*',
          no_proxy: '*',
        },
      },
    );
    const start = stdout.indexOf('{"');
    assert.ok(start >= 0, `Claude Code produced no JSON result:\n${stdout.slice(0, 800)}`);
    return JSON.parse(stdout.slice(start)) as ClaudeResult;
  };

  it('connects, completes a turn, and reports no error', { skip: skip || false }, async () => {
    const res = await run('Reply with a one-sentence summary of this project. Do not use any tools.');
    assert.equal(res.is_error, false, `Claude Code reported an error: ${res.result}`);
    assert.equal(res.stop_reason, 'end_turn');
    assert.ok((res.usage?.input_tokens ?? 0) > 100, 'a real client sends a large prompt; this one did not reach the provider');
    assert.ok(res.result.length > 0, 'no content came back through the gateway');
  });

  it('runs a multi-turn tool loop whose calls have real effects', { skip: skip || false }, async () => {
    const res = await run('Create a file `evidence.md` that describes this project, then read it back.');

    assert.equal(res.is_error, false, `Claude Code reported an error: ${res.result}`);
    // More than one turn means Meridian carried a tool_use block out, Claude Code
    // executed it, and the tool_result came back in and was understood.
    assert.ok(res.num_turns >= 2, `expected a tool loop, saw ${res.num_turns} turn(s): ${res.result}`);

    const written = join(project, 'evidence.md');
    assert.ok(existsSync(written), 'the tool call must have had a real effect on disk, not just been described');
    assert.ok(readFileSync(written, 'utf8').length > 0);
  });

  it('records the traffic as its own, with local inference costed at zero', { skip: skip || false }, async () => {
    const usage = (await (await fetch(`${base}/api/usage?limit=100`)).json()) as {
      summary: { totals: { requests: number; tokens: number; cost: number; failures: number } };
    };
    assert.ok(usage.summary.totals.requests >= 2, 'the gateway should have recorded the client traffic');
    assert.ok(usage.summary.totals.tokens > 1000, 'a real client prompt is large; the token accounting should show it');
    assert.equal(usage.summary.totals.cost, 0, 'local inference must never be reported as having cost money');
    assert.equal(usage.summary.totals.failures, 0, 'no request from the client should have failed');
  });
});
