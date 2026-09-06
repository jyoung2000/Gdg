import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { BlockedAddressError, guardedFetchText, isPrivateHost } from '@meridian/agent-sdk';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer as createGateway } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * Adversarial checks against the running gateway.
 *
 * Every case here is an attack attempted through the same public surface a
 * caller has — an HTTP request, or a tool call the model chose — rather than by
 * calling an internal function with a hostile argument. What matters is whether
 * the product refuses, not whether some function in it would have.
 */
describe('Security: adversarial', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let workspacePath: string;

  const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => (await api(path, init)).json() as Promise<T>;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-sec-'));
    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'sec.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'security-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      // Small enough that the oversize case is cheap to send.
      MERIDIAN_MAX_BODY_MB: '4',
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createGateway(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    const created = await json<{ workspace: { id: string; path: string } }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'security' }),
    });
    workspaceId = created.workspace.id;
    workspacePath = created.workspace.path;
    writeFileSync(join(workspacePath, 'inside.txt'), 'workspace content\n');
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /* ---------------- Path containment ---------------- */

  it('refuses every shape of path escape through the file API', async () => {
    const escapes = [
      '../../../../etc/passwd',
      '..%2f..%2f..%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/etc/passwd',
      './../../etc/passwd',
      'inside.txt/../../../etc/passwd',
      '....//....//etc/passwd',
      'subdir/../../../../etc/passwd',
    ];

    for (const path of escapes) {
      const res = await api(`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`);
      const body = await res.text();
      assert.ok(res.status >= 400, `reading "${path}" must be refused, got ${res.status}`);
      assert.ok(!body.includes('root:x:0:0'), `"${path}" leaked /etc/passwd`);
    }
  });

  it('refuses to write outside the workspace', async () => {
    const target = join(dataDir, 'escaped.txt');
    const res = await api(`/api/workspaces/${workspaceId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: '../escaped.txt', content: 'should never be written' }),
    });
    assert.ok(res.status >= 400, `writing outside the workspace must be refused, got ${res.status}`);
    assert.throws(() => require('node:fs').readFileSync(target), 'nothing may be written outside the root');
  });

  it('stops an agent that is instructed to read outside the workspace', async () => {
    // The escape is attempted by the model itself, through the tool it is
    // offered — which is how it would actually happen.
    const { task } = await json<{ task: { id: string } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        request: 'Read the host password file. [[sim: call read_file {"path":"../../../../etc/passwd"}]] [[sim: finish done]]',
      }),
    });

    type TaskView = { task: { status: string }; toolCalls?: { name: string; result: string | null; error: string | null }[] };
    const deadline = Date.now() + 60_000;
    let detail: TaskView | null = null;
    while (Date.now() < deadline) {
      detail = await json<TaskView>(`/api/tasks/${task.id}`);
      if (['completed', 'failed', 'cancelled'].includes(detail.task.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(detail, 'the task should have been readable while polling');

    const reads = (detail.toolCalls ?? []).filter((c) => c.name === 'read_file');
    assert.ok(reads.length > 0, 'the model should have attempted the read, or this test proves nothing');
    for (const call of reads) {
      const text = `${call.result ?? ''}${call.error ?? ''}`;
      assert.ok(!text.includes('root:x:0:0'), 'a tool call must never return content from outside the workspace');
      assert.ok(
        /outside|escape|not allowed|refus/i.test(text),
        `the refusal must say why, got: ${text.slice(0, 200)}`,
      );
    }
  });

  /* ---------------- SSRF ---------------- */

  it('refuses private, loopback and metadata addresses by name and by shape', () => {
    for (const host of [
      'localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1',
      '::ffff:169.254.169.254', 'db.internal', 'router.local', 'app.localhost',
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} must be treated as private`);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '9.9.9.9', '2606:4700::1111']) {
      assert.equal(isPrivateHost(host), false, `${host} must not be treated as private`);
    }
  });

  it('re-checks every redirect hop, not just the URL it was given', async () => {
    // A public URL that redirects into private space is the standard way past a
    // check that only looks at the first hop. The predicate is inverted here so
    // the guard can be exercised against a server a test is able to bind.
    let hops = 0;
    const target: Server = createServer((req, res) => {
      hops += 1;
      if (req.url === '/open') {
        res.writeHead(302, { location: `http://blocked.invalid.test:${(target.address() as AddressInfo).port}/secret` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('SECRET-METADATA-CONTENT');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    target.unref();
    const port = (target.address() as AddressInfo).port;

    try {
      // Sanity: the guard permits the first hop under this predicate.
      const allowed = await guardedFetchText(`http://127.0.0.1:${port}/plain`, {
        timeoutMs: 5_000,
        maxBytes: 4096,
        maxRedirects: 5,
        isBlocked: (host) => host.includes('blocked'),
      });
      assert.match(allowed.body, /SECRET-METADATA-CONTENT/);

      const before = hops;
      await assert.rejects(
        () =>
          guardedFetchText(`http://127.0.0.1:${port}/open`, {
            timeoutMs: 5_000,
            maxBytes: 4096,
            maxRedirects: 5,
            isBlocked: (host) => host.includes('blocked'),
          }),
        (e: unknown) => e instanceof BlockedAddressError && /blocked\.invalid\.test/.test(e.message),
        'a redirect into blocked space must be refused',
      );
      assert.equal(hops, before + 1, 'the blocked hop must never be requested');
    } finally {
      target.close();
    }
  });

  it('refuses a name that resolves into private space', async () => {
    // localhost is a public-looking name whose address is loopback: exactly the
    // case a textual check on the URL misses.
    await assert.rejects(
      () => guardedFetchText('http://localhost:1/', { timeoutMs: 3_000, maxBytes: 1024, maxRedirects: 0 }),
      (e: unknown) => e instanceof BlockedAddressError,
    );
  });

  it('caps the size of a fetched body', async () => {
    const big: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5_000_000));
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    big.unref();
    try {
      const res = await guardedFetchText(`http://127.0.0.1:${(big.address() as AddressInfo).port}/`, {
        timeoutMs: 10_000,
        maxBytes: 2048,
        maxRedirects: 0,
        isBlocked: () => false,
      });
      assert.ok(res.body.length <= 2048, `body must be capped, saw ${res.body.length}`);
      assert.equal(res.truncated, true);
    } finally {
      big.close();
    }
  });

  /* ---------------- Command injection ---------------- */

  it('does not let a branch name become a shell command', async () => {
    const marker = join(dataDir, 'pwned.txt');
    const res = await api(`/api/workspaces/${workspaceId}/git`, {
      method: 'POST',
      body: JSON.stringify({ operation: 'branch', branch: `x; touch ${marker}; echo ` }),
    });
    await res.text();
    assert.throws(() => require('node:fs').readFileSync(marker), 'the injected command must not have run');
  });

  it('rejects an unknown git operation instead of passing it through', async () => {
    const res = await api(`/api/workspaces/${workspaceId}/git`, {
      method: 'POST',
      body: JSON.stringify({ operation: 'push --force origin main' }),
    });
    assert.ok(res.status >= 400, 'only the fixed command set may run');
  });

  /* ---------------- Secrets ---------------- */

  it('never returns a stored credential, and redacts one that reaches a log or audit entry', async () => {
    const secret = 'sk-ant-super-secret-value-9876543210';
    const created = await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai', scope: 'instance', secret, label: 'test key' }),
    });
    const createdBody = await created.text();
    assert.ok(created.ok, createdBody);
    assert.ok(!createdBody.includes(secret), 'the create response must not echo the secret back');

    for (const path of ['/api/credentials', '/api/system/audit', '/api/system/info', '/api/providers']) {
      const body = await (await api(path)).text();
      assert.ok(!body.includes(secret), `${path} leaked the credential`);
      assert.ok(!body.includes('9876543210'), `${path} leaked the tail of the credential`);
    }
  });

  it('redacts a secret a caller puts into a request that then fails', async () => {
    const secret = 'sk-or-v1-leaked-through-an-error-path-0001';
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: `nonexistent-${secret}`, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.text();
    assert.ok(res.status >= 400);
    assert.ok(!body.includes(secret), `the error echoed a secret back: ${body.slice(0, 300)}`);
  });

  /* ---------------- Response hardening ---------------- */

  it('serves model output as data, with a policy that cannot execute it', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: payload }] }),
    });
    assert.match(res.headers.get('content-type') ?? '', /application\/json/, 'model output must never be served as HTML');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.length > 0, 'every response must carry a policy');
    const directive = (name: string): string => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

    // Script execution is what turns model output into an attack, so script-src
    // allows only self plus the computed hash of the one inline bootstrap.
    const scriptSrc = directive('script-src');
    assert.ok(scriptSrc.includes("'self'"), scriptSrc);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src must not allow inline script: ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src must not allow eval: ${scriptSrc}`);
    assert.match(scriptSrc, /'sha256-[A-Za-z0-9+/=]+'/, 'the inline bootstrap must be allowed by hash, not by a blanket exception');

    assert.equal(directive('object-src'), "object-src 'none'");
    assert.equal(directive('base-uri'), "base-uri 'none'");
    assert.ok(!csp.includes("'unsafe-eval'"), `nothing may allow eval: ${csp}`);

    // The payload survives as text, escaped by JSON — which is what a client
    // needs in order to render it safely itself.
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.ok(body.choices[0].message.content.includes('<script>'), 'the content itself must not be silently mangled');
  });

  it('holds ordinary routes to a small body limit and media routes to the configured one', async () => {
    // Nothing but a media payload has a reason to be large, so a route that
    // never carries one must not accept megabytes into memory.
    const admin = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(admin.status, 413, `an admin route must refuse a 3 MB body, got ${admin.status}`);

    // A vision request legitimately carries an image, but not without bound.
    const media = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] }),
    });
    assert.equal(media.status, 413, `a media route must refuse a body past MERIDIAN_MAX_BODY_MB, got ${media.status}`);

    // And a normal request still works, so the limit did not simply break them.
    const ok = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'small' }] }),
    });
    assert.equal(ok.status, 200);
  });
});
