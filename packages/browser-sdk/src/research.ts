import { randomUUID } from 'node:crypto';
import { MeridianError } from '@meridian/shared';
import type { BrowserManager } from './manager.js';
import type { BrowserEngineId, PageSnapshot, ResearchRecord } from './types.js';

/**
 * Generalized web research on top of the browser layer.
 *
 * Three honest limits are built in rather than bolted on:
 *  - robots.txt is consulted for automated extraction, and a disallowed path is
 *    refused, not worked around;
 *  - one domain is never hammered — fetches to the same host are spaced out;
 *  - no method here can bypass a CAPTCHA, a login wall or a paywall. A page
 *    that refuses to be read comes back as a failed record that says so.
 */

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const DEFAULT_DOMAIN_INTERVAL_MS = 2_000;
const MAX_POLITENESS_WAIT_MS = 15_000;
const MAX_LLM_INPUT_CHARS = 18_000;

export interface ExtractField {
  name: string;
  /** Human description of what to pull out; the LLM sees this verbatim. */
  description: string;
  type?: 'string' | 'number' | 'boolean' | 'string[]';
}

export interface ExtractRequest {
  url: string;
  objective: string;
  fields: ExtractField[];
  /** Reuse an existing session (keeps cookies/policy); otherwise a scoped one is created. */
  sessionId?: string;
  engine?: BrowserEngineId | 'fast' | 'compat' | 'auto';
  /** Skip the cache and fetch the page again. */
  fresh?: boolean;
  /** Skip LLM escalation entirely — deterministic methods only. */
  noLlm?: boolean;
}

/**
 * The escalation hook: deterministic extraction first, a model only when the
 * page's structure did not answer. Injected by the gateway so this package
 * stays free of routing concerns; the implementation there goes through the
 * normal router with the caller's economics (free-first by default).
 */
export type LlmExtractor = (input: {
  objective: string;
  fields: ExtractField[];
  url: string;
  title: string;
  text: string;
  outline: string;
}) => Promise<{ data: Record<string, unknown>; confidence: number; modelId: string | null }>;

export interface ResearchEngineOptions {
  manager: BrowserManager;
  llmExtract?: LlmExtractor;
  /** Persist a finished record; the gateway backs this with its store. */
  persist?: (record: ResearchRecord) => Promise<void>;
  domainIntervalMs?: number;
  now?: () => number;
  /** Test hook: fetch robots.txt text (null = unreachable). Defaults to global fetch. */
  fetchRobots?: (origin: string) => Promise<string | null>;
}

interface CachedPage {
  at: number;
  snapshot: PageSnapshot;
}

interface RobotsRules {
  at: number;
  /** Path prefixes disallowed for `*`; null when robots.txt was unreachable. */
  disallow: string[] | null;
}

/** Minimal robots.txt reading: the `User-agent: *` group's Disallow prefixes. */
export function parseRobots(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const disallow: string[] = [];
  let inStar = false;
  let sawAgentAfterRules = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (sawAgentAfterRules) inStar = false;
      if (value === '*') inStar = true;
      sawAgentAfterRules = false;
      continue;
    }
    if (key === 'disallow' || key === 'allow') sawAgentAfterRules = true;
    if (inStar && key === 'disallow' && value) disallow.push(value);
  }
  return disallow;
}

export function robotsDisallows(pathname: string, disallow: string[]): boolean {
  return disallow.some((prefix) => prefix !== '' && pathname.startsWith(prefix));
}

export class ResearchEngine {
  private readonly manager: BrowserManager;
  private readonly llmExtract: LlmExtractor | null;
  private readonly persist: ((record: ResearchRecord) => Promise<void>) | null;
  private readonly domainIntervalMs: number;
  private readonly now: () => number;
  private readonly fetchRobotsText: (origin: string) => Promise<string | null>;

  private readonly cache = new Map<string, CachedPage>();
  private readonly robots = new Map<string, RobotsRules>();
  private readonly lastFetchByDomain = new Map<string, number>();
  private readonly records: ResearchRecord[] = [];

  constructor(opts: ResearchEngineOptions) {
    this.manager = opts.manager;
    this.llmExtract = opts.llmExtract ?? null;
    this.persist = opts.persist ?? null;
    this.domainIntervalMs = opts.domainIntervalMs ?? DEFAULT_DOMAIN_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.fetchRobotsText =
      opts.fetchRobots ??
      (async (origin: string) => {
        try {
          const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8_000), redirect: 'follow' });
          if (!res.ok) return null;
          return (await res.text()).slice(0, 200_000);
        } catch {
          return null;
        }
      });
  }

  listRecords(limit = 50): ResearchRecord[] {
    return this.records.slice(-limit);
  }

  /** Fetch a page and return its readable reduction, with cache and politeness. */
  async scrape(input: {
    url: string;
    sessionId?: string;
    engine?: BrowserEngineId | 'fast' | 'compat' | 'auto';
    fresh?: boolean;
  }): Promise<{ snapshot: PageSnapshot; fromCache: boolean; robots: 'allowed' | 'unavailable' }> {
    const url = new URL(input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new MeridianError('invalid_request', 'Only http(s) pages can be scraped');
    }

    if (!input.fresh) {
      const hit = this.cache.get(input.url);
      if (hit && this.now() - hit.at < CACHE_TTL_MS) {
        return { snapshot: hit.snapshot, fromCache: true, robots: 'allowed' };
      }
    }

    const robots = await this.checkRobots(url);
    if (robots === 'disallowed') {
      throw new MeridianError(
        'invalid_request',
        `${url.hostname}${url.pathname} is disallowed by the site's robots.txt for automated access; Meridian does not scrape past it`,
      );
    }

    await this.politeDelay(url.hostname);

    const ownSession = !input.sessionId;
    const sessionId =
      input.sessionId ??
      (
        await this.manager.createSession({
          engine: input.engine ?? 'auto',
          task: `research: ${input.url.slice(0, 120)}`,
          idleTimeoutMs: 120_000,
        })
      ).id;

    try {
      let snapshot = await this.manager.navigate(sessionId, input.url);
      // Client-rendered pages need a beat; bounded, and only when empty.
      for (let i = 0; i < 4 && snapshot.text.trim().length < 40; i++) {
        await this.manager.wait(sessionId, { ms: 750 });
        snapshot = await this.manager.snapshot(sessionId);
      }
      this.remember(input.url, snapshot);
      return { snapshot, fromCache: false, robots };
    } finally {
      if (ownSession) await this.manager.closeSession(sessionId).catch(() => undefined);
    }
  }

  /**
   * Structured extraction with the escalation order fixed as DOM → a11y → LLM.
   * Every attempt produces a provenance record, including the failures.
   */
  async extract(req: ExtractRequest): Promise<ResearchRecord> {
    const base: Omit<ResearchRecord, 'method' | 'data' | 'confidence' | 'modelId' | 'error' | 'finalUrl' | 'title' | 'engine'> = {
      id: `rr_${randomUUID().slice(0, 12)}`,
      sessionId: req.sessionId ?? null,
      objective: req.objective,
      sourceUrl: req.url,
      at: this.now(),
    };

    let snapshot: PageSnapshot;
    try {
      ({ snapshot } = await this.scrape({ url: req.url, sessionId: req.sessionId, engine: req.engine, fresh: req.fresh }));
    } catch (e) {
      const record: ResearchRecord = {
        ...base,
        finalUrl: req.url,
        title: '',
        engine: 'chromium',
        method: 'dom',
        data: null,
        confidence: 0,
        modelId: null,
        error: e instanceof Error ? e.message : String(e),
      };
      await this.keep(record);
      return record;
    }

    const engine = req.sessionId
      ? (this.manager.listSessions().find((s) => s.id === req.sessionId)?.engine ?? 'chromium')
      : (req.engine === 'lightpanda' || req.engine === 'fast' ? 'lightpanda' : 'chromium');

    // 1. DOM: fields that map onto page structure directly.
    const dom = extractFromDom(snapshot, req.fields);
    if (dom.complete) {
      const record: ResearchRecord = {
        ...base,
        finalUrl: snapshot.url,
        title: snapshot.title,
        engine,
        method: 'dom',
        data: dom.data,
        confidence: 0.9,
        modelId: null,
        error: null,
      };
      await this.keep(record);
      return record;
    }

    // 2. Accessibility layer: names, roles, links, outline.
    const a11y = extractFromA11y(snapshot, req.fields, dom.data);
    if (a11y.complete) {
      const record: ResearchRecord = {
        ...base,
        finalUrl: snapshot.url,
        title: snapshot.title,
        engine,
        method: 'accessibility',
        data: a11y.data,
        confidence: 0.65,
        modelId: null,
        error: null,
      };
      await this.keep(record);
      return record;
    }

    // 3. A model reads the page. Only when configured and not opted out.
    if (!req.noLlm && this.llmExtract) {
      try {
        const result = await this.llmExtract({
          objective: req.objective,
          fields: req.fields,
          url: snapshot.url,
          title: snapshot.title,
          text: snapshot.text.slice(0, MAX_LLM_INPUT_CHARS),
          outline: snapshot.outline.slice(0, 4_000),
        });
        const record: ResearchRecord = {
          ...base,
          finalUrl: snapshot.url,
          title: snapshot.title,
          engine,
          method: 'llm',
          data: { ...a11y.data, ...result.data },
          confidence: Math.max(0, Math.min(1, result.confidence)),
          modelId: result.modelId,
          error: null,
        };
        await this.keep(record);
        return record;
      } catch (e) {
        const record: ResearchRecord = {
          ...base,
          finalUrl: snapshot.url,
          title: snapshot.title,
          engine,
          method: 'llm',
          data: a11y.data,
          confidence: 0.3,
          modelId: null,
          error: `LLM extraction failed: ${e instanceof Error ? e.message : String(e)}`,
        };
        await this.keep(record);
        return record;
      }
    }

    // Deterministic methods only, and they were partial: return what exists,
    // scored as partial — never dressed up as a complete answer.
    const filled = Object.values(a11y.data).filter((v) => v != null).length;
    const record: ResearchRecord = {
      ...base,
      finalUrl: snapshot.url,
      title: snapshot.title,
      engine,
      method: 'accessibility',
      data: a11y.data,
      confidence: req.fields.length === 0 ? 0.5 : (0.5 * filled) / req.fields.length,
      modelId: null,
      error: filled < req.fields.length ? `Only ${filled}/${req.fields.length} fields could be extracted without a model` : null,
    };
    await this.keep(record);
    return record;
  }

  private async keep(record: ResearchRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > 500) this.records.splice(0, this.records.length - 500);
    if (this.persist) await this.persist(record).catch(() => undefined);
  }

  private remember(url: string, snapshot: PageSnapshot): void {
    this.cache.set(url, { at: this.now(), snapshot });
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  private async checkRobots(url: URL): Promise<'allowed' | 'unavailable' | 'disallowed'> {
    const origin = url.origin;
    let rules = this.robots.get(origin);
    if (!rules || this.now() - rules.at > 60 * 60_000) {
      const text = await this.fetchRobotsText(origin);
      rules = { at: this.now(), disallow: text == null ? null : parseRobots(text) };
      this.robots.set(origin, rules);
    }
    if (rules.disallow == null) return 'unavailable';
    return robotsDisallows(url.pathname, rules.disallow) ? 'disallowed' : 'allowed';
  }

  /** Space out automated fetches per domain; waits are bounded, not unbounded queues. */
  private async politeDelay(hostname: string): Promise<void> {
    const last = this.lastFetchByDomain.get(hostname) ?? 0;
    const wait = Math.min(Math.max(0, last + this.domainIntervalMs - this.now()), MAX_POLITENESS_WAIT_MS);
    // Reserve the slot before sleeping so concurrent callers stack politely.
    this.lastFetchByDomain.set(hostname, Math.max(this.now(), last + this.domainIntervalMs));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// ---- deterministic extraction ----------------------------------------------

const FIELD_PATTERNS: { test: RegExp; get: (snap: PageSnapshot) => unknown }[] = [
  { test: /^(title|page_?title|headline)$/i, get: (s) => s.title || firstHeading(s) },
  { test: /^(url|link|page_?url)$/i, get: (s) => s.url },
  { test: /^(text|content|body|article)$/i, get: (s) => s.text || null },
  { test: /^(links|urls|hrefs)$/i, get: (s) => s.elements.filter((e) => e.href).map((e) => ({ name: e.name, href: e.href })) },
  { test: /^(headings?|outline|sections?)$/i, get: (s) => (s.outline ? s.outline.split('\n').slice(0, 40) : null) },
];

function firstHeading(snap: PageSnapshot): string | null {
  const h = snap.outline.split('\n').find((line) => /^h[1-4]:/.test(line.trim()));
  return h ? h.trim().replace(/^h[1-4]:\s*/, '') : null;
}

function extractFromDom(snap: PageSnapshot, fields: ExtractField[]): { data: Record<string, unknown>; complete: boolean } {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const pattern = FIELD_PATTERNS.find((p) => p.test.test(field.name));
    const value = pattern ? pattern.get(snap) : null;
    if (value != null && (typeof value !== 'string' || value.length > 0)) data[field.name] = value;
  }
  return { data, complete: fields.length > 0 && fields.every((f) => data[f.name] != null) };
}

function extractFromA11y(
  snap: PageSnapshot,
  fields: ExtractField[],
  seed: Record<string, unknown>,
): { data: Record<string, unknown>; complete: boolean } {
  const data: Record<string, unknown> = { ...seed };
  for (const field of fields) {
    if (data[field.name] != null) continue;
    // Match the field's name/description against accessible names; a labelled
    // control or link whose name mentions the field is the best deterministic
    // guess the a11y layer can make.
    const needle = field.name.replace(/[_-]+/g, ' ').toLowerCase();
    const hit = snap.elements.find((e) => e.name.toLowerCase().includes(needle));
    if (hit) data[field.name] = hit.value ?? hit.href ?? hit.name;
  }
  return { data, complete: fields.length > 0 && fields.every((f) => data[f.name] != null) };
}
