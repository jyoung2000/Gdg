/**
 * The browser layer's shared vocabulary.
 *
 * A session is the unit of control: it has one engine, one profile, its own
 * cookies, its own timeout, its own log, and it can always be observed and
 * terminated. Nothing here assumes a particular browser implementation — that
 * is the provider's job — and nothing here can express "bypass a control":
 * there is no primitive for solving a CAPTCHA, stealing a cookie, or ignoring
 * a site's refusal, deliberately.
 */

export type BrowserEngineId = 'chromium' | 'lightpanda' | 'cdp';

export interface BrowserEngineInfo {
  id: BrowserEngineId;
  /** Honest availability, checked at startup — not assumed from configuration. */
  available: boolean;
  /** Why it is unavailable, when it is. */
  detail: string | null;
  /** What this engine is good at, for the router's choice and the UI's label. */
  note: string;
}

export type SessionStatus = 'starting' | 'ready' | 'navigating' | 'closed' | 'failed';

export interface BrowserSessionInfo {
  id: string;
  engine: BrowserEngineId;
  profile: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  /** The current page, or null before the first navigation. */
  url: string | null;
  title: string | null;
  /** What this session is doing, for the sessions panel. */
  task: string | null;
  /** Idle lifetime; the session closes itself when it elapses. */
  idleTimeoutMs: number;
  pages: number;
  activePage: number;
}

export interface SessionLogEntry {
  at: number;
  kind: 'action' | 'navigation' | 'console' | 'error' | 'network' | 'lifecycle';
  message: string;
}

/**
 * A page reduced to what an agent can act on.
 *
 * Interactive elements get stable refs (`e1`, `e2`, …) that remain valid until
 * the next snapshot of the same page. Acting by ref rather than by raw CSS
 * keeps the model's actions reviewable — the log says "clicked e12: button
 * 'Sign in'", not an opaque selector.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Readable text content, trimmed and capped. */
  text: string;
  /** The accessibility tree, serialised compactly for model consumption. */
  outline: string;
  elements: SnapshotElement[];
  /** True when the text or element list was cut at the cap. */
  truncated: boolean;
  capturedAt: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  /** Accessible name, placeholder or trimmed text — whatever identifies it. */
  name: string;
  /** input/select/textarea current value, when readable and not a password. */
  value?: string;
  enabled: boolean;
  /** href for links, so extraction can follow without another lookup. */
  href?: string;
}

export interface ClickOptions {
  ref: string;
}

export interface FillOptions {
  ref: string;
  text: string;
  /** Press Enter after filling, for search boxes. */
  submit?: boolean;
}

export interface SelectOptions {
  ref: string;
  value: string;
}

export interface WaitOptions {
  /** Milliseconds, capped by the session policy. */
  ms?: number;
  /** Wait until this text appears in the page. */
  forText?: string;
  /** Wait for a URL change away from this URL. */
  forNavigation?: boolean;
}

export interface ScreenshotResult {
  /** PNG bytes, base64. */
  data: string;
  width: number;
  height: number;
}

export interface DownloadPolicy {
  enabled: boolean;
  maxBytes: number;
}

/**
 * Where a session may go.
 *
 * Deny wins over allow; an empty allow list means "anywhere the deny list does
 * not forbid". Private-network targets are refused independently of this list
 * unless the policy explicitly opts a host in — reaching the operator's
 * internal services is an exfiltration path, not a research tool.
 */
export interface DomainPolicy {
  allow: string[];
  deny: string[];
  /** Hostnames under private/loopback space that are explicitly permitted (e.g. a local dev server under test). */
  allowPrivate: string[];
}

export interface BrowserProfileInfo {
  name: string;
  createdAt: number;
  /** Cookie count only — never cookie values — for the profiles panel. */
  cookies: number;
  origins: number;
  lastUsedAt: number | null;
}

/** One provenance record per extraction, persisted by the research engine. */
export interface ResearchRecord {
  id: string;
  sessionId: string | null;
  /** What the caller asked for. */
  objective: string;
  sourceUrl: string;
  finalUrl: string;
  title: string;
  engine: BrowserEngineId;
  method: 'dom' | 'accessibility' | 'llm';
  /** The extracted fields, shaped by the caller's schema. */
  data: unknown;
  /** 0..1; heuristic for dom/a11y, model-reported for llm. */
  confidence: number;
  modelId: string | null;
  error: string | null;
  at: number;
}
