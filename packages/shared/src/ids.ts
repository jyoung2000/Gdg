/**
 * Identifier helpers.
 *
 * Built on the Web Crypto API rather than `node:crypto` so this module — and
 * therefore the whole shared package — imports cleanly into the browser bundle.
 * Node has provided the same global since v19, so there is one implementation
 * rather than a runtime split.
 */

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** Prefixed identifier. The prefix makes a log line self-describing. */
export function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

/** Short opaque token, e.g. a request id in a header. */
export function shortId(bytes = 8): string {
  return randomHex(bytes);
}

/** A UUID, for the few places one is expected by an external contract. */
export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Canonical global model id. */
export function modelKey(providerId: string, providerModelId: string): string {
  return `${providerId}:${providerModelId}`;
}

/** Inverse of {@link modelKey}. Returns null when the input is not qualified. */
export function parseModelKey(key: string): { providerId: string; providerModelId: string } | null {
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  return { providerId: key.slice(0, idx), providerModelId: key.slice(idx + 1) };
}
