/**
 * Secret redaction.
 *
 * Applied on every log line, every audit entry and every tool-call record that
 * is persisted or shown in the UI. The rule is conservative: when a string
 * looks like a credential, it is masked, even at the cost of the occasional
 * false positive.
 */

const REDACTED = '[redacted]';

/** Field names whose values are always masked, regardless of shape. */
const SENSITIVE_KEYS = new Set(
  [
    'apikey', 'api_key', 'key', 'secret', 'token', 'accesstoken', 'access_token',
    'refreshtoken', 'refresh_token', 'password', 'passwd', 'authorization', 'auth',
    'cookie', 'session', 'sessionid', 'credential', 'credentials', 'privatekey',
    'private_key', 'clientsecret', 'client_secret', 'masterkey', 'master_key',
    'bearer', 'x-api-key', 'anthropic-api-key', 'signingkey', 'passphrase',
  ].map((k) => k.toLowerCase()),
);

/**
 * Patterns for well-known credential shapes. Each has a distinctive prefix so
 * the false-positive rate on ordinary prose stays near zero.
 */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,              // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,          // Anthropic
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}/g,        // OpenRouter
  /\bgsk_[A-Za-z0-9]{20,}/g,               // Groq
  /\bcsk-[A-Za-z0-9]{20,}/g,               // Cerebras
  /\bAIza[A-Za-z0-9_-]{30,}/g,             // Google
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,         // GitHub
  /\bhf_[A-Za-z0-9]{20,}/g,                // Hugging Face
  /\br8_[A-Za-z0-9]{20,}/g,                // Replicate
  /\bkey-[A-Za-z0-9]{24,}/g,               // fal.ai
  /\bxai-[A-Za-z0-9]{20,}/g,               // xAI
  /\bAKIA[0-9A-Z]{16}\b/g,                 // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,  // bare bearer tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** Mask credential-shaped substrings inside a free-text string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Deep-redact an arbitrary value: masks sensitive keys wholesale and scrubs
 * credential-shaped text everywhere else. Cycles are handled; the result is
 * always JSON-serialisable.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]' as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen)) as unknown as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as unknown as T;
  }
  if (value instanceof Date) return value as unknown as T;
  if (value instanceof Uint8Array) return `[binary ${value.byteLength}B]` as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' && v.length > 0 ? REDACTED : v === null ? null : REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out as unknown as T;
}

/** The last four characters of a secret, for display. Never the secret itself. */
export function hintOf(secret: string): string {
  if (!secret) return '';
  return secret.length <= 4 ? '•'.repeat(secret.length) : `••••${secret.slice(-4)}`;
}

/** True when a string contains anything that looks like a credential. */
export function containsSecret(input: string): boolean {
  return PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(input);
  });
}
