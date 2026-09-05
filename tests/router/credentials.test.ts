import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialResolver, MemoryCredentialStore } from '@meridian/routing-sdk';
import { credential } from '../helpers/harness.js';

describe('Credential resolution', () => {
  it('follows the documented precedence: user, workspace, admin, system', () => {
    const store = new MemoryCredentialStore([
      credential({ id: 'sys', providerId: 'p', scope: 'system', priority: 1 }),
      credential({ id: 'adm', providerId: 'p', scope: 'admin', priority: 1 }),
      credential({ id: 'ws', providerId: 'p', scope: 'workspace', workspaceId: 'w1', priority: 1 }),
      credential({ id: 'usr', providerId: 'p', scope: 'user', userId: 'u1', priority: 1 }),
    ]);
    const resolver = new CredentialResolver(store, () => 0);

    assert.equal(resolver.resolve({ providerId: 'p', userId: 'u1', workspaceId: 'w1' }, true).credential?.id, 'usr');
    assert.equal(resolver.resolve({ providerId: 'p', workspaceId: 'w1' }, true).credential?.id, 'ws');
    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential?.id, 'adm');
  });

  it('does not hand one user’s credential to another', () => {
    const store = new MemoryCredentialStore([credential({ id: 'usr', providerId: 'p', scope: 'user', userId: 'u1' })]);
    const resolver = new CredentialResolver(store, () => 0);

    const other = resolver.resolve({ providerId: 'p', userId: 'u2' }, true);
    assert.equal(other.credential, null);
    assert.match(other.reason, /No credential available/);
  });

  it('honours an explicitly named credential, and reports when it cannot be used', () => {
    const store = new MemoryCredentialStore([
      credential({ id: 'a', providerId: 'p', priority: 1 }),
      credential({ id: 'b', providerId: 'p', priority: 99 }),
      credential({ id: 'disabled', providerId: 'p', enabled: false }),
    ]);
    const resolver = new CredentialResolver(store, () => 0);

    assert.equal(resolver.resolve({ providerId: 'p', explicitCredentialId: 'a' }, true).credential?.id, 'a');
    // Falling back silently would hide that the caller's choice was ignored.
    const bad = resolver.resolve({ providerId: 'p', explicitCredentialId: 'disabled' }, true);
    assert.equal(bad.credential, null);
    assert.match(bad.reason, /unavailable/);
  });

  it('skips expired credentials', () => {
    let clock = 0;
    const store = new MemoryCredentialStore([credential({ id: 'exp', providerId: 'p', expiresAt: 100 })]);
    const resolver = new CredentialResolver(store, () => clock);

    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential?.id, 'exp');
    clock = 200;
    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential, null);
  });

  it('returns an anonymous resolution only for providers that need no auth', () => {
    const resolver = new CredentialResolver(new MemoryCredentialStore([]), () => 0);

    const anon = resolver.resolve({ providerId: 'p' }, false);
    assert.equal(anon.anonymous, true);
    assert.equal(anon.credential, null);

    const needsAuth = resolver.resolve({ providerId: 'p' }, true);
    assert.equal(needsAuth.anonymous, false);
  });

  it('rotates round-robin across a pool’s credentials', () => {
    const store = new MemoryCredentialStore(
      [
        credential({ id: 'k1', providerId: 'p', poolId: 'pool', priority: 100 }),
        credential({ id: 'k2', providerId: 'p', poolId: 'pool', priority: 100 }),
        credential({ id: 'k3', providerId: 'p', poolId: 'pool', priority: 100 }),
      ],
      [{ id: 'pool', providerId: 'p', name: 'Pool', strategy: 'round-robin', enabled: true, createdAt: 0 }],
    );
    const resolver = new CredentialResolver(store, () => 0);

    const picks = [0, 1, 2, 3].map(() => resolver.resolve({ providerId: 'p' }, true).credential?.id);
    assert.deepEqual(picks, ['k1', 'k2', 'k3', 'k1']);
  });

  it('prefers the highest priority under the default strategy', () => {
    const store = new MemoryCredentialStore([
      credential({ id: 'low', providerId: 'p', priority: 10 }),
      credential({ id: 'high', providerId: 'p', priority: 900 }),
    ]);
    const resolver = new CredentialResolver(store, () => 0);
    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential?.id, 'high');
  });

  it('respects a credential’s own concurrency limit', () => {
    const store = new MemoryCredentialStore([
      credential({ id: 'limited', providerId: 'p', maxConcurrency: 1, priority: 900 }),
      credential({ id: 'spare', providerId: 'p', priority: 1 }),
    ]);
    const resolver = new CredentialResolver(store, () => 0);

    const first = resolver.resolve({ providerId: 'p' }, true);
    assert.equal(first.credential?.id, 'limited');
    const release = resolver.acquire('limited');

    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential?.id, 'spare', 'a saturated key must not be handed out again');
    release();
    assert.equal(resolver.resolve({ providerId: 'p' }, true).credential?.id, 'limited');
  });

  it('never exposes a secret through the public record view', () => {
    const store = new MemoryCredentialStore([credential({ id: 'k', providerId: 'p', secret: 'super-secret-value' })]);
    const records = store.publicRecords();
    assert.equal(records.length, 1);
    assert.equal(JSON.stringify(records).includes('super-secret-value'), false);
    assert.ok(records[0].hint.length > 0);
  });
});
