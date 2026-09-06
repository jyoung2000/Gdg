import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPrivateHost } from './net.js';

export interface GuardedFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Which hosts and addresses are off limits. Defaults to {@link isPrivateHost}.
   *
   * Injectable so the redirect and DNS guards can be exercised against a local
   * test server: with the real predicate every address a test could bind to is
   * already blocked, which would make the guard untestable — and an untested
   * guard is how the redirect hole got there in the first place.
   */
  isBlocked?: (hostOrAddress: string) => boolean;
}

export interface GuardedFetchResult {
  status: number;
  contentType: string;
  body: string;
  /** The URL the content actually came from, after redirects. */
  finalUrl: string;
  truncated: boolean;
}

export class BlockedAddressError extends Error {}

/**
 * Fetch a public URL with the address guard applied where it matters.
 *
 * Checking the hostname of the URL a model supplied is not enough, and the two
 * holes it leaves are the standard ways to reach a metadata service:
 *
 *  - A public URL that redirects to `169.254.169.254`. `fetch(..., {redirect:
 *    'follow'})` follows it without re-checking, so the guard only ever saw the
 *    harmless first hop. Redirects are followed here one at a time, and every
 *    hop is checked.
 *  - A hostname that simply *resolves* to a private address. It is not a
 *    literal IP, so a textual check passes it. The guard therefore runs inside
 *    the DNS lookup, on the address the socket is actually about to connect to,
 *    which also closes most of the rebinding window: a second resolution
 *    between check and connect cannot happen, because this *is* the resolution.
 *
 * Node's own `lookup` hook is the only place that holds for both IPv4 and IPv6
 * and for every address a name resolves to, which is why this uses
 * http/https.request rather than fetch.
 */
export async function guardedFetchText(target: string, opts: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const blocked = opts.isBlocked ?? isPrivateHost;
  let url = new URL(target);
  const seen: string[] = [];

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedAddressError(`Only http and https URLs can be fetched (got ${url.protocol.replace(':', '')})`);
    }
    if (blocked(url.hostname)) {
      throw new BlockedAddressError(`Refusing to fetch a loopback, link-local or private-network address (${url.hostname})`);
    }
    seen.push(url.toString());

    const res = await once(url, opts, blocked);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && typeof location === 'string' && location) {
      res.message.resume(); // Drain the redirect body rather than leaking the socket.
      if (hop === opts.maxRedirects) {
        throw new BlockedAddressError(`Too many redirects (${seen.length}) starting at ${seen[0]}`);
      }
      url = new URL(location, url);
      continue;
    }

    const { body, truncated } = await readBody(res.message, opts.maxBytes);
    return {
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body,
      finalUrl: url.toString(),
      truncated,
    };
  }

  throw new BlockedAddressError(`Too many redirects starting at ${seen[0]}`);
}

interface Response {
  status: number;
  headers: IncomingMessage['headers'];
  message: IncomingMessage;
}

function once(url: URL, opts: GuardedFetchOptions, blocked: (host: string) => boolean): Promise<Response> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        // Redirects are followed by the caller so each hop is re-checked.
        headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8', ...opts.headers },
        lookup: makeGuardedLookup(blocked),
        timeout: opts.timeoutMs,
        signal: opts.signal,
      },
      (message) => resolve({ status: message.statusCode ?? 0, headers: message.headers, message }),
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

function readBody(message: IncomingMessage, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    message.on('data', (chunk: Buffer) => {
      if (size >= maxBytes) return;
      // A body larger than the cap is cut at the cap and the socket destroyed,
      // so a hostile or merely enormous page cannot exhaust memory.
      const room = maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (size >= maxBytes) {
        truncated = true;
        message.destroy();
      }
    });
    message.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated }));
    message.on('close', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated }));
    message.on('error', reject);
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A DNS lookup that refuses to hand back a private address.
 *
 * Every address a name resolves to is checked, not just the first: a name that
 * returns one public and one private address must not be reachable by retrying.
 */
function makeGuardedLookup(blocked: (address: string) => boolean) {
  return function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: number };
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const list = addresses as LookupAddress[];
    for (const entry of list) {
      if (blocked(entry.address)) {
        const blocked: NodeJS.ErrnoException = new BlockedAddressError(
          `Refusing to connect to ${hostname}: it resolves to the private or link-local address ${entry.address}`,
        );
        blocked.code = 'EACCES';
        callback(blocked, '');
        return;
      }
    }
    if (opts.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
  };
}
