import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, containsSecret, hintOf, redact, redactString } from '@meridian/shared';
import { SecretBox, generateApiKey, hashApiKey, hashPassword, safeEqual, verifyPassword } from '../../apps/gateway/src/db/crypto.js';
import { openDatabase } from '../../apps/gateway/src/db/database.js';
import { nullLogger } from '@meridian/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLES = [
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA',
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'r8_ABCDEFGHIJKLMNOPQRSTUVWXYZ012',
  'xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'AKIAIOSFODNN7EXAMPLE',
];

describe('Secret redaction', () => {
  it('masks every credential shape it claims to know', () => {
    for (const secret of SAMPLES) {
      const masked = redactString(`the key is ${secret} ok`);
      assert.equal(masked.includes(secret), false, `failed to mask ${secret.slice(0, 8)}…`);
      assert.match(masked, /\[redacted\]/);
    }
  });

  it('masks sensitive keys regardless of the value shape', () => {
    const masked = redact({ apiKey: 'plainvalue', authorization: 'Basic abc', nested: { token: 'zzz', safe: 'keep me' } }) as Record<string, unknown>;
    assert.equal(masked.apiKey, '[redacted]');
    assert.equal((masked.nested as Record<string, unknown>).token, '[redacted]');
    assert.equal((masked.nested as Record<string, unknown>).safe, 'keep me');
  });

  it('survives cycles and binary payloads without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => JSON.stringify(redact(cyclic)));
    const withBinary = redact({ blob: new Uint8Array([1, 2, 3]) }) as Record<string, unknown>;
    assert.match(String(withBinary.blob), /binary 3B/);
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'The sky is blue and the deploy finished at 10:42 with exit code 0.';
    assert.equal(redactString(prose), prose);
    assert.equal(containsSecret(prose), false);
  });

  it('keeps secrets out of log output even when a caller passes one', () => {
    const lines: string[] = [];
    const logger = createLogger({ format: 'json', level: 'debug', sink: (l) => lines.push(l) });
    logger.info('calling provider', { apiKey: SAMPLES[0], note: `bearer ${SAMPLES[1]}` });

    const joined = lines.join('\n');
    assert.equal(joined.includes(SAMPLES[0]), false);
    assert.equal(joined.includes(SAMPLES[1]), false);
    assert.match(joined, /redacted/);
  });

  it('hints reveal only the tail', () => {
    const hint = hintOf('sk-1234567890abcdef');
    assert.equal(hint, '••••cdef');
    assert.equal(hint.includes('1234567890'), false);
  });
});

describe('Credential encryption', () => {
  function tempDb() {
    const dir = mkdtempSync(join(tmpdir(), 'meridian-test-'));
    const db = openDatabase(join(dir, 'test.db'), nullLogger);
    return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('round-trips a secret and produces different ciphertext each time', () => {
    const { db, cleanup } = tempDb();
    const box = SecretBox.create(db, 'master-key-for-tests');

    const secret = 'sk-super-secret-value';
    const a = box.seal(secret);
    const b = box.seal(secret);
    assert.notEqual(a, b, 'a fresh IV must make repeated sealings differ');
    assert.equal(box.open(a), secret);
    assert.equal(box.open(b), secret);
    assert.equal(a.includes(secret), false);
    cleanup();
  });

  it('refuses to open ciphertext that was tampered with', () => {
    const { db, cleanup } = tempDb();
    const box = SecretBox.create(db, 'master-key-for-tests');
    const sealed = box.seal('sk-value');

    const [iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    assert.equal(box.open(`${iv}.${tag}.${flipped.toString('base64')}`), null);
    assert.equal(box.open('garbage'), null);
    assert.equal(box.open(null), null);
    cleanup();
  });

  it('refuses to open ciphertext sealed under a different master key', () => {
    const { db, cleanup } = tempDb();
    const sealed = SecretBox.create(db, 'key-one').seal('sk-value');
    // Same salt, different master key: authentication must fail.
    assert.equal(SecretBox.create(db, 'key-two').open(sealed), null);
    cleanup();
  });

  it('generates a key when none is configured, and says so', () => {
    const { db, cleanup } = tempDb();
    const box = SecretBox.create(db, null);
    assert.equal(box.derivedFromEnv, false);
    assert.equal(box.open(box.seal('x')), 'x');
    cleanup();
  });
});

describe('API keys and passwords', () => {
  it('stores only a hash of a gateway key', () => {
    const key = generateApiKey();
    assert.match(key, /^mrd-/);
    const hash = hashApiKey(key);
    assert.equal(hash.includes(key), false);
    assert.equal(hashApiKey(key), hash, 'hashing must be deterministic for lookup');
    assert.notEqual(hashApiKey(generateApiKey()), hash);
  });

  it('verifies passwords and rejects wrong ones', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
    assert.equal(verifyPassword('x', 'not-a-valid-hash'), false);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });
});
