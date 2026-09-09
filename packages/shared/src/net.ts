/**
 * Which network addresses Meridian will reach, and which it refuses to.
 *
 * This lives in `shared` because four different parts of the product need the
 * same answer and had started to grow their own: an agent's fetch tool, the
 * browser engine, the discovery engine pulling community datasets, and the
 * admin route that lets an operator point a provider at a different endpoint.
 * A guard that exists in four versions is a guard with three holes in it.
 *
 * The threat is not abstract. A URL that reaches `169.254.169.254` reaches the
 * cloud metadata service, which hands out instance credentials to anyone who
 * asks from inside. A provider base URL is worse than a fetch tool: every
 * request to that provider carries the operator's API key in an `Authorization`
 * header, so a base URL pointed at an attacker's collector — or at an internal
 * service that logs what it receives — exfiltrates the credential itself.
 *
 * A textual check on a hostname is necessary and never sufficient: a name
 * resolves to whatever its owner wants. The complete guard is this module plus
 * a DNS-level check at connect time (`guardedFetchText` in agent-sdk), and this
 * module is written to be used by both.
 */

/* ------------------------------------------------------------------ */
/* IPv4, in all the ways it can be written                             */
/* ------------------------------------------------------------------ */

/**
 * Reduce the many spellings of an IPv4 address to dotted quad, or null.
 *
 * `http://2130706433/`, `http://0177.0.0.1/` and `http://0x7f.1/` all reach
 * 127.0.0.1, because `inet_aton` accepts decimal, octal and hex, and accepts
 * one, two, three or four parts. A guard that only recognises `127.0.0.1` sees
 * a hostname it cannot parse, decides it is a domain name, and lets it through.
 *
 * Returning null means "this is not an IPv4 address in any spelling" — a real
 * hostname, which the DNS-level guard judges instead.
 */
export function normalizeIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // inet_aton: the final part absorbs however many octets are left over, so
  // `127.1` is 127.0.0.1 and `2130706433` is the whole address in one number.
  const last = values[values.length - 1];
  const leading = values.slice(0, -1);
  if (leading.some((v) => v > 255)) return null;
  const room = 4 - leading.length;
  if (last >= 2 ** (8 * room)) return null;

  const octets = [...leading];
  for (let i = room - 1; i >= 0; i -= 1) octets.push((last >>> (8 * i)) & 0xff);
  return octets.join('.');
}

/* ------------------------------------------------------------------ */
/* Private space                                                       */
/* ------------------------------------------------------------------ */

/**
 * Is this host inside space that must not be reachable from user-supplied URLs?
 *
 * Loopback, link-local and RFC1918 are where cloud metadata services and an
 * operator's internal systems live. Carrier-grade NAT (100.64/10) is included
 * because it is routinely used for internal infrastructure — and because
 * Alibaba Cloud's metadata service is at 100.100.100.200, inside it.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === '') return true;

  // Names that resolve inside a network by convention rather than by DNS.
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // Kubernetes and Docker service names, and the Google metadata alias.
  if (h.endsWith('.svc') || h.endsWith('.svc.cluster.local') || h === 'metadata' || h === 'metadata.google.internal') {
    return true;
  }

  if (h.includes(':')) return isPrivateIpv6(h);

  const v4 = normalizeIpv4(h);
  if (!v4) return false;
  return isPrivateIpv4(v4);
}

function isPrivateIpv4(dotted: string): boolean {
  const [a, b] = dotted.split('.').map(Number);
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and every cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. 192.0.0.0/24
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, and Alibaba metadata
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, and 255.255.255.255
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(host)) return true; // unique local fc00::/7 — includes AWS's fd00:ec2::254
  if (/^ff/.test(host)) return true; // multicast

  // Forms that carry an IPv4 address inside them reach that address, so they
  // are judged as it: IPv4-mapped, IPv4-compatible, 6to4 and NAT64.
  const embedded =
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host) ??
    /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host) ??
    /^64:ff9b::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (embedded) return isPrivateHost(embedded[1]);

  const hexEmbedded = /^(?:::ffff:|2002:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})/i.exec(host);
  if (hexEmbedded) {
    const high = Number.parseInt(hexEmbedded[1], 16);
    const low = Number.parseInt(hexEmbedded[2], 16);
    const dotted = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
    return isPrivateIpv4(dotted);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Judging a URL                                                       */
/* ------------------------------------------------------------------ */

export const URL_REJECTIONS = [
  'unparseable',
  'scheme',
  'credentials',
  'private-address',
  'fragment',
] as const;
export type UrlRejection = (typeof URL_REJECTIONS)[number];

export type UrlVerdict =
  | { ok: true; url: URL; private: boolean }
  | { ok: false; reason: UrlRejection; message: string };

export interface UrlPolicy {
  /**
   * Permit loopback and private addresses.
   *
   * True for a provider the operator declared local — Ollama, LM Studio and
   * llama.cpp all live on 127.0.0.1, and a guard that refused them would break
   * the one deployment that costs nothing to run. False for anything whose URL
   * arrived from a dataset, a form field, or a model.
   */
  allowPrivate?: boolean;
  /** Permit `http:` as well as `https:`. Loopback needs it; the internet does not. */
  allowInsecure?: boolean;
}

/**
 * Judge a URL before anything is sent to it.
 *
 * This is the textual half. It cannot see what a hostname resolves to, so it
 * is a first filter and a source of clear error messages — never the only
 * check. Pair it with a DNS-level guard for anything that then makes a request.
 */
export function assessUrl(raw: string, policy: UrlPolicy = {}): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable', message: `"${raw}" is not a URL.` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      reason: 'scheme',
      message: `Only http and https are allowed here (got ${url.protocol.replace(':', '')}).`,
    };
  }

  const isPrivate = isPrivateHost(url.hostname);

  if (url.protocol === 'http:' && !policy.allowInsecure && !isPrivate) {
    return {
      ok: false,
      reason: 'scheme',
      message: 'Refusing plain http to a public host: an API key sent over it is readable in transit.',
    };
  }

  // `https://key@evil.example/` puts a secret in a URL, which means in logs, in
  // error messages and in anything that echoes the endpoint back.
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'credentials',
      message: 'A URL with a username or password in it is not accepted; credentials belong in the credential store.',
    };
  }

  if (url.hash) {
    return { ok: false, reason: 'fragment', message: 'A base URL must not carry a fragment.' };
  }

  if (isPrivate && !policy.allowPrivate) {
    return {
      ok: false,
      reason: 'private-address',
      message:
        `${url.hostname} is a loopback, link-local, or private-network address. ` +
        'Cloud metadata services live there, and a request sent there carries this provider’s API key with it.',
    };
  }

  return { ok: true, url, private: isPrivate };
}

/**
 * Judge a base URL an operator or a dataset supplied for a provider.
 *
 * Private space is allowed only for a provider that genuinely runs locally.
 * That is not a formality: the difference between "Ollama on 127.0.0.1" and
 * "OpenAI, but pointed at 127.0.0.1" is that the second one sends an API key.
 */
export function assessProviderBaseUrl(raw: string, opts: { local: boolean }): UrlVerdict {
  const verdict = assessUrl(raw, { allowPrivate: opts.local, allowInsecure: opts.local });
  if (!verdict.ok) return verdict;
  if (verdict.private && !opts.local) {
    return {
      ok: false,
      reason: 'private-address',
      message: `${verdict.url.hostname} is a private address, and this provider is not marked as running locally.`,
    };
  }
  return verdict;
}
