import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { DB } from './database.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Credential encryption.
 *
 * Secrets are sealed with AES-256-GCM under a key derived from the operator's
 * master key via scrypt. GCM is authenticated, so a tampered ciphertext fails
 * to decrypt rather than yielding garbage that gets sent to a provider.
 *
 * The per-instance salt lives in the database and the master key does not: an
 * attacker with the database file alone cannot derive the key. If no master key
 * is configured, one is generated and written to the settings table so a
 * single-user install works out of the box — with a startup warning, because
 * that arrangement protects against a leaked backup but not against read access
 * to the live database.
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly derivedFromEnv: boolean;

  private constructor(key: Buffer, derivedFromEnv: boolean) {
    this.key = key;
    this.derivedFromEnv = derivedFromEnv;
  }

  static create(db: DB, masterKey: string | null): SecretBox {
    const now = Date.now();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('crypto.salt') as { value: string } | undefined;
    let salt: Buffer;
    if (row) {
      salt = Buffer.from(row.value, 'base64');
    } else {
      salt = randomBytes(SALT_BYTES);
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('crypto.salt', salt.toString('base64'), now);
    }

    let secret = masterKey;
    let fromEnv = true;
    if (!secret) {
      fromEnv = false;
      const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('crypto.generated_key') as { value: string } | undefined;
      if (stored) {
        secret = stored.value;
      } else {
        secret = randomBytes(32).toString('base64');
        db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('crypto.generated_key', secret, now);
      }
    }

    // N=2^15 keeps startup well under a second while staying far above a
    // plain hash in cost to an attacker.
    const key = scryptSync(secret, salt, KEY_BYTES, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
    return new SecretBox(key, fromEnv);
  }

  /** Seal a secret. Output is `iv.tag.ciphertext`, base64url-free base64. */
  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }

  /** Open a sealed secret. Returns null on any tampering or key mismatch. */
  open(sealed: string | null): string | null {
    if (!sealed) return null;
    const parts = sealed.split('.');
    if (parts.length !== 3) return null;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[1], 'base64');
      const enc = Buffer.from(parts[2], 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch {
      // A failed open means the ciphertext was written under a different master
      // key, or was altered. Both are the caller's problem to report, not ours
      // to guess at.
      return null;
    }
  }
}

/** Hash a gateway API key for storage. Keys are high-entropy, so SHA-256 is right. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison, safe on unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Generate a gateway API key with a recognisable prefix. */
export function generateApiKey(): string {
  return `mrd-${randomBytes(24).toString('base64url')}`;
}

/**
 * Password hashing for the optional local login. scrypt with a per-password
 * salt; the parameters are recorded in the stored string so they can be raised
 * later without invalidating existing hashes.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 96 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
