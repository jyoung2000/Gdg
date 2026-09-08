import { randomUUID } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import { MeridianError } from '@meridian/shared';
import type { BrowserProvider, ProviderSession } from './provider.js';
import type {
  BrowserEngineId,
  BrowserEngineInfo,
  BrowserProfileInfo,
  BrowserSessionInfo,
  ClickOptions,
  DomainPolicy,
  FillOptions,
  PageSnapshot,
  ScreenshotResult,
  SelectOptions,
  SessionLogEntry,
  WaitOptions,
} from './types.js';

const LOG_CAP = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_IDLE_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_OP_TIMEOUT_MS = 45_000;
const MAX_SESSIONS = 8;

/**
 * Loopback, link-local and private space a browser session must not reach.
 *
 * Same reasoning as the agent fetch tool: a browser that can be steered to the
 * operator's internal services or a cloud metadata endpoint is an exfiltration
 * path. Kept local to this package so browser-sdk stays dependency-light; the
 * logic mirrors agent-sdk's `isPrivateHost` deliberately.
 */
export function isPrivateBrowserHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateBrowserHost(mapped[1]);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function hostMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return h === p || h.endsWith(`.${p}`);
}

/**
 * The one place a URL is judged against the session's policy.
 *
 * Deny beats allow; a non-empty allow list is a hard whitelist; private space
 * needs an explicit `allowPrivate` entry regardless of the allow list. Schemes
 * that never leave the machine (about:, data:, blob:) pass — blocking them
 * breaks pages without protecting anything.
 */
export function urlAllowed(rawUrl: string, policy: DomainPolicy): { allowed: boolean; reason: string | null } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'not a valid URL' };
  }
  if (url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') return { allowed: true, reason: null };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `scheme ${url.protocol} is not allowed` };
  }
  const host = url.hostname;
  if (policy.deny.some((d) => hostMatches(host, d))) return { allowed: false, reason: `${host} is on the deny list` };
  if (isPrivateBrowserHost(host) && !policy.allowPrivate.some((d) => hostMatches(host, d))) {
    return {
      allowed: false,
      reason: `${host} is a private or internal address; add it to the session's allowPrivate list to permit it explicitly`,
    };
  }
  if (policy.allow.length > 0 && !policy.allow.some((d) => hostMatches(host, d))) {
    return { allowed: false, reason: `${host} is outside the session's allow list` };
  }
  return { allowed: true, reason: null };
}

/**
 * How long a resolution is trusted before it is looked up again.
 *
 * Short, because the whole point is to notice a name whose answer changes.
 */
const DNS_CACHE_MS = 30_000;

const dnsLookup = promisify(dnsLookupCb) as (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<{ address: string; family: number }[]>;

const dnsCache = new Map<string, { private: boolean; addresses: string[]; at: number }>();

/**
 * Does this name actually resolve into private space?
 *
 * `urlAllowed` above judges the hostname as text, and that leaves the standard
 * hole open: `metadata.evil.example` is not a literal IP, passes every textual
 * check, and resolves to `169.254.169.254`. The HTTP fetch path has closed this
 * for a while by guarding inside Node's DNS `lookup` hook; the browser path had
 * no equivalent, so the two were not at parity and the browser was the weaker
 * one.
 *
 * Every address a name resolves to is checked, not just the first: a name with
 * one public and one private answer is a private answer waiting to be used.
 *
 * **What this does not close.** A name re-resolved between this check and the
 * browser's own connection could return a different address — the classic
 * rebinding window. Closing that needs a hook inside the browser's socket
 * layer, which Playwright does not expose. This removes the easy case (a name
 * that simply points at private space) and leaves the racy one, which is worth
 * stating rather than implying a completeness that is not there.
 */
export async function resolvesToPrivate(hostname: string, now = Date.now()): Promise<{ private: boolean; addresses: string[] }> {
  const key = hostname.toLowerCase();
  const cached = dnsCache.get(key);
  if (cached && now - cached.at < DNS_CACHE_MS) return { private: cached.private, addresses: cached.addresses };

  try {
    const results = await dnsLookup(key, { all: true, verbatim: true });
    const addresses = results.map((r) => r.address);
    const isPrivate = addresses.some((a) => isPrivateBrowserHost(a));
    dnsCache.set(key, { private: isPrivate, addresses, at: now });
    return { private: isPrivate, addresses };
  } catch {
    // A name that will not resolve cannot be reached, so there is nothing to
    // protect against. Reporting it private would turn a typo into a
    // security-sounding error the user cannot act on.
    return { private: false, addresses: [] };
  }
}

/**
 * The full navigation check: policy, then where the name really points.
 *
 * Used where a URL enters from outside — a model's `browse` call, an operator's
 * address bar — because that is where a hostile or mistaken name arrives. The
 * synchronous `urlAllowed` still guards every subresource, where a DNS lookup
 * per request would cost more than it protects.
 */
export async function checkNavigation(
  rawUrl: string,
  policy: DomainPolicy,
): Promise<{ allowed: boolean; reason: string | null }> {
  const textual = urlAllowed(rawUrl, policy);
  if (!textual.allowed) return textual;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return textual;
  // An operator who allow-listed this host explicitly has already made the
  // decision; re-litigating it from DNS would override them.
  if (policy.allowPrivate.some((d) => hostMatches(url.hostname, d))) return textual;

  const resolved = await resolvesToPrivate(url.hostname);
  if (resolved.private) {
    return {
      allowed: false,
      reason: `${url.hostname} resolves to a private or internal address (${resolved.addresses.join(', ')}); add it to allowPrivate to permit it explicitly`,
    };
  }
  return { allowed: true, reason: null };
}

/** Persistence hooks; the gateway backs these with its store, tests with a Map. */
export interface ProfileStore {
  load(name: string): Promise<{ state: string; createdAt: number; lastUsedAt: number | null } | null>;
  save(name: string, state: string, meta: { createdAt: number; lastUsedAt: number }): Promise<void>;
  list(): Promise<{ name: string; state: string; createdAt: number; lastUsedAt: number | null }[]>;
  remove(name: string): Promise<void>;
}

export class MemoryProfileStore implements ProfileStore {
  private readonly profiles = new Map<string, { state: string; createdAt: number; lastUsedAt: number | null }>();
  async load(name: string) {
    return this.profiles.get(name) ?? null;
  }
  async save(name: string, state: string, meta: { createdAt: number; lastUsedAt: number }) {
    const existing = this.profiles.get(name);
    this.profiles.set(name, { state, createdAt: existing?.createdAt ?? meta.createdAt, lastUsedAt: meta.lastUsedAt });
  }
  async list() {
    return Array.from(this.profiles.entries()).map(([name, p]) => ({ name, ...p }));
  }
  async remove(name: string) {
    this.profiles.delete(name);
  }
}

export interface CreateSessionInput {
  /** 'fast' prefers Lightpanda and falls back; 'compat' and 'auto' take Chromium. */
  engine?: BrowserEngineId | 'fast' | 'compat' | 'auto';
  profile?: string;
  task?: string;
  idleTimeoutMs?: number;
  policy?: Partial<DomainPolicy>;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

export interface BrowserManagerOptions {
  providers: Partial<Record<BrowserEngineId, BrowserProvider>>;
  profiles?: ProfileStore;
  defaultPolicy?: Partial<DomainPolicy>;
  now?: () => number;
  onEvent?: (sessionId: string, entry: SessionLogEntry) => void;
}

interface ManagedSession {
  id: string;
  engine: BrowserEngineId;
  /** What was asked for, which may differ from what runs after a fallback. */
  requestedEngine: string;
  profile: string;
  status: BrowserSessionInfo['status'];
  createdAt: number;
  lastActivityAt: number;
  task: string | null;
  idleTimeoutMs: number;
  policy: DomainPolicy;
  session: ProviderSession | null;
  log: SessionLogEntry[];
  idleTimer: NodeJS.Timeout | null;
  /** Aborts the in-flight operation, if any; a kill switch for the UI. */
  currentOp: AbortController | null;
  userAgent?: string;
  viewport?: { width: number; height: number };
  fellBack: boolean;
}

/**
 * Owns every live browser session: creation with engine fallback, the domain
 * policy, per-operation timeouts, the observable log, idle reaping, and
 * termination. Providers do browsing; this class does control.
 */
export class BrowserManager {
  private readonly providers: Partial<Record<BrowserEngineId, BrowserProvider>>;
  private readonly profiles: ProfileStore;
  private readonly defaultPolicy: DomainPolicy;
  private readonly now: () => number;
  private readonly onEvent?: (sessionId: string, entry: SessionLogEntry) => void;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(opts: BrowserManagerOptions) {
    this.providers = opts.providers;
    this.profiles = opts.profiles ?? new MemoryProfileStore();
    this.defaultPolicy = {
      allow: opts.defaultPolicy?.allow ?? [],
      deny: opts.defaultPolicy?.deny ?? [],
      allowPrivate: opts.defaultPolicy?.allowPrivate ?? [],
    };
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  async engines(): Promise<BrowserEngineInfo[]> {
    const out: BrowserEngineInfo[] = [];
    for (const engine of ['chromium', 'lightpanda', 'cdp'] as BrowserEngineId[]) {
      const provider = this.providers[engine];
      if (!provider) {
        out.push({ id: engine, available: false, detail: 'No provider configured for this engine', note: '' });
        continue;
      }
      out.push(await provider.info());
    }
    return out;
  }

  async createSession(input: CreateSessionInput): Promise<BrowserSessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new MeridianError('rate_limited', `Session limit reached (${MAX_SESSIONS}); close an existing browser session first`);
    }
    const requested = input.engine ?? 'auto';
    const profileName = input.profile ?? 'default';
    const policy: DomainPolicy = {
      allow: input.policy?.allow ?? this.defaultPolicy.allow,
      deny: input.policy?.deny ?? this.defaultPolicy.deny,
      allowPrivate: input.policy?.allowPrivate ?? this.defaultPolicy.allowPrivate,
    };

    const managed: ManagedSession = {
      id: `bs_${randomUUID().slice(0, 12)}`,
      engine: 'chromium',
      requestedEngine: requested,
      profile: profileName,
      status: 'starting',
      createdAt: this.now(),
      lastActivityAt: this.now(),
      task: input.task ?? null,
      idleTimeoutMs: Math.min(Math.max(input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 30_000), MAX_IDLE_TIMEOUT_MS),
      policy,
      session: null,
      log: [],
      idleTimer: null,
      currentOp: null,
      userAgent: input.userAgent,
      viewport: input.viewport,
      fellBack: false,
    };
    this.sessions.set(managed.id, managed);

    try {
      const { engine, session, fellBack, detail } = await this.openProviderSession(managed, requested);
      managed.engine = engine;
      managed.session = session;
      managed.fellBack = fellBack;
      managed.status = 'ready';
      this.record(managed, 'lifecycle', `session started on ${engine}${fellBack ? ` (requested ${requested}: ${detail})` : ''}`);
      this.armIdleTimer(managed);
      return this.infoOf(managed);
    } catch (e) {
      managed.status = 'failed';
      this.record(managed, 'error', `session failed to start: ${e instanceof Error ? e.message : String(e)}`);
      this.sessions.delete(managed.id);
      throw e;
    }
  }

  /**
   * Resolve the requested engine to a live provider session.
   *
   * 'fast' means Lightpanda when it is actually reachable — availability is
   * probed, not assumed — and Chromium otherwise, with the reason logged so the
   * downgrade is visible rather than silent.
   */
  private async openProviderSession(
    managed: ManagedSession,
    requested: string,
  ): Promise<{ engine: BrowserEngineId; session: ProviderSession; fellBack: boolean; detail: string | null }> {
    // 'cdp' (the user's real browser) is always a hard request: silently
    // swapping it for a headless Chromium would have actions land somewhere
    // the user is not looking.
    const order: BrowserEngineId[] =
      requested === 'cdp' ? ['cdp'] : requested === 'lightpanda' || requested === 'fast' ? ['lightpanda', 'chromium'] : ['chromium'];
    const hardRequest = requested === 'lightpanda' || requested === 'cdp';

    let lastDetail: string | null = null;
    for (const engine of order) {
      const provider = this.providers[engine];
      if (!provider) {
        lastDetail = `${engine} has no provider configured`;
        if (hardRequest && engine === order[0]) throw new MeridianError('unsupported_capability', lastDetail);
        continue;
      }
      try {
        const session = await provider.createSession({
          storageState: (await this.profiles.load(managed.profile))?.state ?? null,
          userAgent: managed.userAgent,
          viewport: managed.viewport,
          requestFilter: (url) => urlAllowed(url, managed.policy).allowed,
          onLog: (kind, message) => this.record(managed, kind, message),
        });
        return { engine, session, fellBack: engine !== order[0], detail: lastDetail };
      } catch (e) {
        lastDetail = e instanceof Error ? e.message : String(e);
        if (hardRequest && engine === order[0]) throw e;
      }
    }
    throw new MeridianError('unsupported_capability', `No browser engine is available: ${lastDetail ?? 'none configured'}`);
  }

  listSessions(): BrowserSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.infoOf(s));
  }

  async sessionInfo(id: string): Promise<BrowserSessionInfo> {
    const managed = this.get(id);
    const info = this.infoOf(managed);
    if (managed.session) {
      info.url = await managed.session.currentUrl();
      info.title = await managed.session.title();
      const tabs = await managed.session.listTabs().catch(() => []);
      info.pages = tabs.length;
      info.activePage = tabs.findIndex((t) => t.active);
    }
    return info;
  }

  logsOf(id: string, limit = 100): SessionLogEntry[] {
    return this.get(id).log.slice(-limit);
  }

  /** Cancel whatever the session is doing right now, without closing it. */
  cancel(id: string): boolean {
    const managed = this.get(id);
    if (!managed.currentOp) return false;
    managed.currentOp.abort();
    this.record(managed, 'action', 'operation cancelled by request');
    return true;
  }

  async closeSession(id: string, opts?: { saveProfile?: boolean }): Promise<void> {
    const managed = this.sessions.get(id);
    if (!managed) return;
    managed.currentOp?.abort();
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (opts?.saveProfile && managed.session) {
      await this.saveProfile(id).catch((e) => this.record(managed, 'error', `profile save failed: ${e instanceof Error ? e.message : e}`));
    }
    await managed.session?.close().catch(() => undefined);
    managed.status = 'closed';
    this.record(managed, 'lifecycle', 'session closed');
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.closeSession(id)));
  }

  /**
   * Release everything, including the browser processes themselves.
   *
   * `closeAll` ends the sessions but leaves the shared browser running, which
   * is right between sessions and wrong at shutdown: a gateway that exits
   * leaving a Chromium behind accumulates one per restart. Called on shutdown;
   * a later session simply launches a new browser.
   */
  async shutdown(): Promise<void> {
    await this.closeAll();
    await Promise.all(Object.values(this.providers).map((p) => p?.close().catch(() => undefined)));
  }

  // ---- actions -------------------------------------------------------------

  async navigate(id: string, url: string, timeoutMs?: number): Promise<PageSnapshot> {
    const managed = this.get(id);
    // The full check, not the textual one: this is where a URL arrives from
    // outside — a model's browse call, an operator's address bar — and so where
    // a name chosen to look public and resolve private would be used.
    const verdict = await checkNavigation(url, managed.policy);
    if (!verdict.allowed) {
      this.record(managed, 'navigation', `refused ${url.slice(0, 200)}: ${verdict.reason}`);
      throw new MeridianError('invalid_request', `Navigation refused: ${verdict.reason}`);
    }
    return this.withOp(managed, timeoutMs, async (signal) => {
      managed.status = 'navigating';
      this.record(managed, 'navigation', url.slice(0, 300));
      try {
        await managed.session!.navigate(url, signal);
      } catch (e) {
        // The fast engine does not render every site. When a navigation dies on
        // Lightpanda, retry once on Chromium with the same cookies and policy —
        // visibly, in the log — instead of reporting a dead end the compat
        // engine would have survived.
        if (managed.engine === 'lightpanda' && this.providers.chromium && !signal.aborted) {
          const reason = e instanceof Error ? e.message : String(e);
          this.record(managed, 'lifecycle', `lightpanda failed on this page (${reason.slice(0, 160)}); retrying on chromium`);
          await this.migrate(managed, 'chromium');
          await managed.session!.navigate(url, signal);
        } else {
          throw e;
        }
      } finally {
        managed.status = 'ready';
      }
      return managed.session!.snapshot(signal);
    });
  }

  /** Swap the underlying engine mid-session, carrying cookies over. */
  private async migrate(managed: ManagedSession, engine: BrowserEngineId): Promise<void> {
    const provider = this.providers[engine];
    if (!provider) throw new MeridianError('unsupported_capability', `${engine} is not configured`);
    const state = await managed.session?.storageState().catch(() => null);
    await managed.session?.close().catch(() => undefined);
    managed.session = await provider.createSession({
      storageState: state ?? null,
      userAgent: managed.userAgent,
      viewport: managed.viewport,
      requestFilter: (url) => urlAllowed(url, managed.policy).allowed,
      onLog: (kind, message) => this.record(managed, kind, message),
    });
    managed.engine = engine;
    managed.fellBack = true;
  }

  async back(id: string): Promise<PageSnapshot> {
    return this.simpleOp(id, 'back', (s, sig) => s.back(sig));
  }

  async forward(id: string): Promise<PageSnapshot> {
    return this.simpleOp(id, 'forward', (s, sig) => s.forward(sig));
  }

  async reload(id: string): Promise<PageSnapshot> {
    return this.simpleOp(id, 'reload', (s, sig) => s.reload(sig));
  }

  async snapshot(id: string): Promise<PageSnapshot> {
    const managed = this.get(id);
    return this.withOp(managed, undefined, (signal) => managed.session!.snapshot(signal));
  }

  async html(id: string, maxBytes = 500_000): Promise<string> {
    const managed = this.get(id);
    return this.withOp(managed, undefined, (signal) => managed.session!.html(signal, Math.min(maxBytes, 2_000_000)));
  }

  async click(id: string, opts: ClickOptions): Promise<PageSnapshot> {
    return this.simpleOp(id, `click ${opts.ref}`, (s, sig) => s.click(opts, sig));
  }

  async fill(id: string, opts: FillOptions): Promise<PageSnapshot> {
    return this.simpleOp(id, `fill ${opts.ref}`, (s, sig) => s.fill(opts, sig));
  }

  async select(id: string, opts: SelectOptions): Promise<PageSnapshot> {
    return this.simpleOp(id, `select ${opts.ref}`, (s, sig) => s.select(opts, sig));
  }

  async hover(id: string, ref: string): Promise<PageSnapshot> {
    return this.simpleOp(id, `hover ${ref}`, (s, sig) => s.hover(ref, sig));
  }

  async press(id: string, key: string): Promise<PageSnapshot> {
    return this.simpleOp(id, `press ${key}`, (s, sig) => s.press(key, sig));
  }

  async scroll(id: string, direction: 'up' | 'down'): Promise<PageSnapshot> {
    return this.simpleOp(id, `scroll ${direction}`, (s, sig) => s.scroll(direction, sig));
  }

  /**
   * Coordinate-addressed input, for a computer agent driving the viewport as a
   * screen. These deliberately do not return a snapshot: a computer agent
   * observes by screenshot, and re-serialising the DOM after every pointer
   * move would cost far more than the action itself.
   */
  async pointerMove(id: string, x: number, y: number): Promise<void> {
    const managed = this.get(id);
    await this.withOp(managed, undefined, (signal) => managed.session!.pointerMove(x, y, signal));
  }

  async pointerClick(id: string, x: number, y: number, opts: { button?: 'left' | 'middle' | 'right'; clickCount?: number } = {}): Promise<void> {
    const managed = this.get(id);
    this.record(managed, 'action', `click ${x},${y}`);
    await this.withOp(managed, undefined, (signal) => managed.session!.pointerClick(x, y, opts, signal));
  }

  async pointerDrag(id: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    const managed = this.get(id);
    this.record(managed, 'action', `drag ${from.x},${from.y} -> ${to.x},${to.y}`);
    await this.withOp(managed, undefined, (signal) => managed.session!.pointerDrag(from, to, signal));
  }

  async typeText(id: string, text: string): Promise<void> {
    const managed = this.get(id);
    this.record(managed, 'action', `type ${text.length} chars`);
    await this.withOp(managed, undefined, (signal) => managed.session!.typeText(text, signal));
  }

  async wait(id: string, opts: WaitOptions): Promise<PageSnapshot> {
    return this.simpleOp(id, 'wait', (s, sig) => s.wait(opts, sig));
  }

  /** Privileged: arbitrary JS in the page. The caller gates who may use it. */
  async evaluate(id: string, expression: string): Promise<string> {
    const managed = this.get(id);
    this.record(managed, 'action', `evaluate (${expression.length} chars)`);
    return this.withOp(managed, undefined, (signal) => managed.session!.evaluate(expression, signal));
  }

  async screenshot(id: string): Promise<ScreenshotResult> {
    const managed = this.get(id);
    return this.withOp(managed, undefined, (signal) => managed.session!.screenshot(signal));
  }

  async listTabs(id: string) {
    return this.get(id).session!.listTabs();
  }

  async openTab(id: string, url: string | null): Promise<number> {
    const managed = this.get(id);
    if (url) {
      const verdict = await checkNavigation(url, managed.policy);
      if (!verdict.allowed) throw new MeridianError('invalid_request', `Navigation refused: ${verdict.reason}`);
    }
    return this.withOp(managed, undefined, (signal) => managed.session!.openTab(url, signal));
  }

  async switchTab(id: string, index: number): Promise<void> {
    await this.get(id).session!.switchTab(index);
    this.touch(this.get(id));
  }

  async closeTab(id: string, index: number): Promise<void> {
    await this.get(id).session!.closeTab(index);
    this.touch(this.get(id));
  }

  // ---- profiles ------------------------------------------------------------

  async saveProfile(id: string, asName?: string): Promise<void> {
    const managed = this.get(id);
    if (!managed.session) throw new MeridianError('invalid_request', 'Session has no live browser');
    const state = await managed.session.storageState();
    const name = asName ?? managed.profile;
    await this.profiles.save(name, state, { createdAt: this.now(), lastUsedAt: this.now() });
    this.record(managed, 'action', `profile "${name}" saved`);
  }

  async listProfiles(): Promise<BrowserProfileInfo[]> {
    const rows = await this.profiles.list();
    return rows.map((row) => {
      let cookies = 0;
      let origins = 0;
      try {
        const parsed = JSON.parse(row.state) as { cookies?: unknown[]; origins?: unknown[] };
        cookies = parsed.cookies?.length ?? 0;
        origins = parsed.origins?.length ?? 0;
      } catch {
        // Counted as zero rather than exposing the raw state.
      }
      return { name: row.name, createdAt: row.createdAt, cookies, origins, lastUsedAt: row.lastUsedAt };
    });
  }

  async deleteProfile(name: string): Promise<void> {
    await this.profiles.remove(name);
  }

  // ---- internals -----------------------------------------------------------

  private get(id: string): ManagedSession {
    const managed = this.sessions.get(id);
    if (!managed || !managed.session) throw new MeridianError('invalid_request', `No browser session ${id}`);
    return managed;
  }

  private async simpleOp(
    id: string,
    label: string,
    fn: (session: ProviderSession, signal: AbortSignal) => Promise<void>,
  ): Promise<PageSnapshot> {
    const managed = this.get(id);
    this.record(managed, 'action', label);
    return this.withOp(managed, undefined, async (signal) => {
      await fn(managed.session!, signal);
      return managed.session!.snapshot(signal);
    });
  }

  /**
   * Every operation runs under its own AbortController: bounded by a timeout,
   * cancellable from outside, serialized per session (a browser page is not a
   * concurrent surface), and always resetting the idle clock.
   */
  private async withOp<T>(managed: ManagedSession, timeoutMs: number | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (managed.currentOp) throw new MeridianError('rate_limited', 'The session is busy with another operation; cancel it or wait');
    const controller = new AbortController();
    managed.currentOp = controller;
    const budget = Math.min(timeoutMs ?? DEFAULT_OP_TIMEOUT_MS, 120_000);
    const timer = setTimeout(() => controller.abort(), budget);
    this.touch(managed);
    try {
      return await fn(controller.signal);
    } catch (e) {
      if (controller.signal.aborted) {
        throw new MeridianError('cancelled', `Browser operation cancelled or timed out after ${budget}ms`);
      }
      // A page that will not load, a dead socket, a bad selector: these are
      // conditions the caller should see as a clean typed error, not a 500.
      // MeridianErrors from deeper down (a refused ref, an unsupported engine)
      // pass through unchanged.
      if (e instanceof MeridianError) throw e;
      throw new MeridianError('provider_unavailable', `Browser operation failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    } finally {
      clearTimeout(timer);
      managed.currentOp = null;
      this.touch(managed);
    }
  }

  private touch(managed: ManagedSession): void {
    managed.lastActivityAt = this.now();
    this.armIdleTimer(managed);
  }

  private armIdleTimer(managed: ManagedSession): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => {
      this.record(managed, 'lifecycle', `idle for ${Math.round(managed.idleTimeoutMs / 1000)}s; closing`);
      void this.closeSession(managed.id, { saveProfile: false });
    }, managed.idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  private record(managed: ManagedSession, kind: SessionLogEntry['kind'], message: string): void {
    const entry: SessionLogEntry = { at: this.now(), kind, message };
    managed.log.push(entry);
    if (managed.log.length > LOG_CAP) managed.log.splice(0, managed.log.length - LOG_CAP);
    this.onEvent?.(managed.id, entry);
  }

  private infoOf(managed: ManagedSession): BrowserSessionInfo {
    return {
      id: managed.id,
      engine: managed.engine,
      profile: managed.profile,
      status: managed.status,
      createdAt: managed.createdAt,
      lastActivityAt: managed.lastActivityAt,
      url: null,
      title: null,
      task: managed.task,
      idleTimeoutMs: managed.idleTimeoutMs,
      pages: 1,
      activePage: 0,
    };
  }
}
