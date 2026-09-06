import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * What one user of a shared instance can reach of another's.
 *
 * With `MERIDIAN_AUTH_REQUIRED=true` "the caller" becomes a specific person, and
 * every route that reads or changes something has to decide whose it is. These
 * tests are written from the attacker's side: two real users, two real API keys,
 * and B trying every way to reach A's credentials, workspaces, tasks, usage and
 * the instance's own administration.
 *
 * They exist because the answer used to be "all of it". `req.auth.scopes` was
 * populated on every request and checked nowhere, so any authenticated user
 * could list, rotate and delete any other user's provider keys.
 */
describe('Security: multi-user isolation', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;
  let base: string;

  let adminKey: string;
  let aliceKey: string;
  let bobKey: string;
  let aliceId: string;
  let aliceCredentialId: string;
  let aliceWorkspaceId: string;

  const call = (path: string, key: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    });

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-multiuser-'));
    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'mu.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'multi-user-test-master-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      MERIDIAN_AUTH_REQUIRED: 'true',
      PORT: '0',
    } as NodeJS.ProcessEnv);

    app = await App.create(config);
    await app.start();
    server = await createServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    // The bootstrap operator is the administrator; Alice and Bob are members,
    // which is what an ordinary user of a shared instance is.
    const operator = app.store.listUsers()[0];
    adminKey = app.store.createApiKey(operator.id, 'admin key').key;
    const alice = app.store.createUser('alice@example.com', 'Alice', 'member');
    const bob = app.store.createUser('bob@example.com', 'Bob', 'member');
    aliceId = alice.id;
    aliceKey = app.store.createApiKey(alice.id, 'alice key').key;
    bobKey = app.store.createApiKey(bob.id, 'bob key').key;

    // Alice's own provider key and her own workspace.
    const cred = (await (
      await call('/api/credentials', aliceKey, {
        method: 'POST',
        body: JSON.stringify({ providerId: 'openai', secret: 'sk-alice-private-key-0001', label: "Alice's key" }),
      })
    ).json()) as { credential: { id: string } };
    aliceCredentialId = cred.credential.id;

    const ws = (await (
      await call('/api/workspaces', aliceKey, { method: 'POST', body: JSON.stringify({ name: "Alice's project" }) })
    ).json()) as { workspace: { id: string } };
    aliceWorkspaceId = ws.workspace.id;
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /* ---------------- Credentials ---------------- */

  it("does not show one user another's credentials", async () => {
    const mine = (await (await call('/api/credentials', aliceKey)).json()) as { credentials: { id: string }[] };
    assert.ok(
      mine.credentials.some((c) => c.id === aliceCredentialId),
      'Alice must see her own credential',
    );

    const theirs = (await (await call('/api/credentials', bobKey)).json()) as { credentials: { id: string }[] };
    assert.ok(
      !theirs.credentials.some((c) => c.id === aliceCredentialId),
      "Bob must not see Alice's credential, even without its secret — provider, label and id are enough to target it",
    );
  });

  it("refuses to let one user rotate or delete another's credential", async () => {
    const rotate = await call(`/api/credentials/${aliceCredentialId}`, bobKey, {
      method: 'PATCH',
      body: JSON.stringify({ secret: 'sk-bob-overwrote-alices-key' }),
    });
    assert.ok(rotate.status >= 400, `Bob must not rotate Alice's key, got ${rotate.status}`);

    const disable = await call(`/api/credentials/${aliceCredentialId}`, bobKey, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    assert.ok(disable.status >= 400, `Bob must not disable Alice's key, got ${disable.status}`);

    const remove = await call(`/api/credentials/${aliceCredentialId}`, bobKey, { method: 'DELETE' });
    assert.ok(remove.status >= 400, `Bob must not delete Alice's key, got ${remove.status}`);

    // And none of it happened.
    const still = (await (await call('/api/credentials', aliceKey)).json()) as { credentials: { id: string; enabled: boolean }[] };
    const record = still.credentials.find((c) => c.id === aliceCredentialId);
    assert.ok(record, "Alice's credential must still exist");
    assert.equal(record.enabled, true, 'and must still be enabled');
  });

  it('says "no such credential" rather than confirming one exists', async () => {
    const real = await call(`/api/credentials/${aliceCredentialId}`, bobKey, { method: 'DELETE' });
    const invented = await call('/api/credentials/cred_0000000000000000', bobKey, { method: 'DELETE' });
    const realBody = (await real.json()) as { error?: { message: string } };
    const inventedBody = (await invented.json()) as { error?: { message: string } };
    // Distinguishable answers would let Bob enumerate which ids are real.
    assert.equal(real.status, invented.status);
    assert.equal(realBody.error?.message, inventedBody.error?.message);
  });

  it('will not let an ordinary user create an instance-wide credential', async () => {
    for (const scope of ['admin', 'system']) {
      const res = await call('/api/credentials', bobKey, {
        method: 'POST',
        body: JSON.stringify({ providerId: 'openai', secret: 'sk-bob-instance-wide', scope }),
      });
      assert.ok(res.status >= 400, `a member must not create a ${scope}-scoped credential, got ${res.status}`);
    }
  });

  it("never routes one user's request onto another user's credential", () => {
    // The resolver is where this is decided, so it is asked directly with Bob's
    // identity and Alice's credential in the store.
    const asBob = app.credentials.resolve({ providerId: 'openai', userId: 'usr_bob_not_alice', workspaceId: null }, true);
    assert.equal(asBob.credential, null, "Bob's request must not resolve onto Alice's key");

    const asAlice = app.credentials.resolve({ providerId: 'openai', userId: aliceId, workspaceId: null }, true);
    assert.equal(asAlice.credential?.id, aliceCredentialId, 'Alice must still get her own');

    // Naming an id is not the same as being entitled to it.
    const named = app.credentials.resolve(
      { providerId: 'openai', userId: 'usr_bob_not_alice', workspaceId: null, explicitCredentialId: aliceCredentialId },
      true,
    );
    assert.equal(named.credential, null, 'an explicitly named credential must still be checked for ownership');
  });

  /* ---------------- Workspaces and tasks ---------------- */

  it("does not show or open another user's workspace", async () => {
    const bobList = (await (await call('/api/workspaces', bobKey)).json()) as { workspaces: { id: string }[] };
    assert.ok(!bobList.workspaces.some((w) => w.id === aliceWorkspaceId), "Bob must not see Alice's workspace");

    for (const [method, path] of [
      ['GET', `/api/workspaces/${aliceWorkspaceId}`],
      ['GET', `/api/workspaces/${aliceWorkspaceId}/tree`],
      ['GET', `/api/workspaces/${aliceWorkspaceId}/file?path=README.md`],
      ['GET', `/api/workspaces/${aliceWorkspaceId}/changes`],
    ] as const) {
      const res = await call(path, bobKey, { method });
      assert.ok(res.status >= 400, `Bob must not reach ${path}, got ${res.status}`);
    }

    const exec = await call(`/api/workspaces/${aliceWorkspaceId}/exec`, bobKey, {
      method: 'POST',
      body: JSON.stringify({ command: 'cat /etc/passwd' }),
    });
    assert.ok(exec.status >= 400, "Bob must not run a command in Alice's workspace");

    const write = await call(`/api/workspaces/${aliceWorkspaceId}/file`, bobKey, {
      method: 'PUT',
      body: JSON.stringify({ path: 'planted.txt', content: 'bob was here' }),
    });
    assert.ok(write.status >= 400, "Bob must not write into Alice's workspace");
  });

  it("does not let one user start or read a task in another's workspace", async () => {
    const start = await call('/api/tasks', bobKey, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: aliceWorkspaceId, request: 'Exfiltrate the source.' }),
    });
    assert.ok(start.status >= 400, "Bob must not start a task in Alice's workspace");

    const own = (await (
      await call('/api/tasks', aliceKey, {
        method: 'POST',
        body: JSON.stringify({ workspaceId: aliceWorkspaceId, request: 'Describe this project.' }),
      })
    ).json()) as { task: { id: string } };

    for (const [method, path] of [
      ['GET', `/api/tasks/${own.task.id}`],
      ['GET', `/api/tasks/${own.task.id}/checkpoints`],
      ['POST', `/api/tasks/${own.task.id}/cancel`],
    ] as const) {
      const res = await call(path, bobKey, { method });
      assert.ok(res.status >= 400, `Bob must not reach ${path}, got ${res.status}`);
    }

    const bobTasks = (await (await call('/api/tasks', bobKey)).json()) as { tasks: { id: string }[] };
    assert.ok(!bobTasks.tasks.some((t) => t.id === own.task.id), "Alice's task must not appear in Bob's list");
  });

  /* ---------------- Administration ---------------- */

  it('keeps instance administration to administrators', async () => {
    const forbidden: [string, string, unknown?][] = [
      ['GET', '/api/system/keys'],
      ['POST', '/api/system/keys', { name: 'bob escalation' }],
      ['GET', '/api/system/audit'],
      ['PATCH', '/api/providers/openai', { trust: 'trusted' }],
      ['POST', '/api/providers/openai/reset-health'],
      ['POST', '/api/pools', { id: 'bob', name: 'Bob', strategy: 'BALANCED' }],
      ['POST', '/api/credentials/pools', { providerId: 'openai', name: 'bob pool' }],
    ];
    for (const [method, path, body] of forbidden) {
      const res = await call(path, bobKey, { method, body: body ? JSON.stringify(body) : undefined });
      assert.ok(res.status >= 400, `a member must not reach ${method} ${path}, got ${res.status}`);
    }

    // The administrator still can, or the check is just breaking the product.
    const asAdmin = await call('/api/system/keys', adminKey);
    assert.equal(asAdmin.status, 200, 'an administrator must still administer');
  });

  it("does not show one user another's usage", async () => {
    const bobUsage = (await (await call('/api/usage?limit=200', bobKey)).json()) as {
      recent: { userId: string | null }[];
    };
    assert.ok(
      bobUsage.recent.every((r) => r.userId === null || r.userId !== aliceId),
      "Bob's usage view must not contain Alice's rows",
    );
  });

  it('rejects an unauthenticated request outright', async () => {
    for (const path of ['/api/credentials', '/api/workspaces', '/api/system/keys', '/api/usage']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} must require authentication when it is turned on`);
    }
  });

  it('honours the scopes an API key was issued with', async () => {
    const narrow = app.store.createApiKey(aliceId, 'inference only', ['inference']).key;

    const credentials = await call('/api/credentials', narrow);
    assert.ok(credentials.status >= 400, 'a key without the credentials scope must not list credentials');

    const workspaces = await call('/api/workspaces', narrow);
    assert.ok(workspaces.status >= 400, 'a key without the workspaces scope must not list workspaces');

    // And it can still do the one thing it was issued for.
    const inference = await call('/v1/chat/completions', narrow, {
      method: 'POST',
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'scoped' }] }),
    });
    assert.equal(inference.status, 200, 'a key with the inference scope must still be able to infer');
  });
});
