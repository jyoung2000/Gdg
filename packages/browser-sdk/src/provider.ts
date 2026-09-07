import type {
  BrowserEngineId,
  BrowserEngineInfo,
  ClickOptions,
  FillOptions,
  PageSnapshot,
  ScreenshotResult,
  SelectOptions,
  WaitOptions,
} from './types.js';

/**
 * What every browser implementation must provide.
 *
 * Meridian is deliberately not wired to one browser. Chromium via Playwright is
 * the compatibility engine; Lightpanda attaches over CDP as the fast engine;
 * anything else that can satisfy this interface can be added without touching
 * the manager, the routes, the tools or the UI.
 */
export interface BrowserProvider {
  readonly engine: BrowserEngineId;
  /** Checked, not assumed: launch or attach must actually have worked once. */
  info(): Promise<BrowserEngineInfo>;
  createSession(opts: ProviderSessionOptions): Promise<ProviderSession>;
  close(): Promise<void>;
}

export interface ProviderSessionOptions {
  /** Serialized storage state (cookies, origins) to restore; null for fresh. */
  storageState: string | null;
  userAgent?: string;
  viewport?: { width: number; height: number };
  /** Called before every request; returning false blocks it. */
  requestFilter: (url: string) => boolean;
  onLog: (kind: 'console' | 'error' | 'network' | 'lifecycle', message: string) => void;
}

/**
 * One live browser context.
 *
 * Every method takes an AbortSignal because every browser operation can hang —
 * a page that never fires load, a dialog nobody dismisses — and the caller's
 * timeout, not the page's goodwill, decides when it ends.
 */
export interface ProviderSession {
  navigate(url: string, signal: AbortSignal): Promise<void>;
  back(signal: AbortSignal): Promise<void>;
  forward(signal: AbortSignal): Promise<void>;
  reload(signal: AbortSignal): Promise<void>;
  currentUrl(): Promise<string | null>;
  title(): Promise<string | null>;

  /** The page reduced to text, outline and actionable elements. */
  snapshot(signal: AbortSignal): Promise<PageSnapshot>;
  /** Raw readable HTML of the page, capped — for deterministic extraction. */
  html(signal: AbortSignal, maxBytes: number): Promise<string>;

  click(opts: ClickOptions, signal: AbortSignal): Promise<void>;
  fill(opts: FillOptions, signal: AbortSignal): Promise<void>;
  select(opts: SelectOptions, signal: AbortSignal): Promise<void>;
  hover(ref: string, signal: AbortSignal): Promise<void>;
  press(key: string, signal: AbortSignal): Promise<void>;
  scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void>;

  /**
   * Raw coordinate input.
   *
   * The ref-based methods above are how an agent acts on a page it has
   * snapshotted. These are how a *computer* agent acts: it grounds against
   * pixels in a screenshot and addresses them directly, exactly as it would on
   * a desktop. Both are needed; neither replaces the other.
   */
  pointerMove(x: number, y: number, signal: AbortSignal): Promise<void>;
  pointerClick(x: number, y: number, opts: { button?: 'left' | 'middle' | 'right'; clickCount?: number }, signal: AbortSignal): Promise<void>;
  pointerDrag(from: { x: number; y: number }, to: { x: number; y: number }, signal: AbortSignal): Promise<void>;
  typeText(text: string, signal: AbortSignal): Promise<void>;
  wait(opts: WaitOptions, signal: AbortSignal): Promise<void>;

  /**
   * Evaluate JavaScript in the page.
   *
   * Powerful and therefore explicit: the manager labels this a privileged
   * action, and the result is capped. The expression runs in the page's world —
   * it cannot reach Meridian's process.
   */
  evaluate(expression: string, signal: AbortSignal): Promise<string>;

  screenshot(signal: AbortSignal): Promise<ScreenshotResult>;

  /** Serialized storage state for profile persistence. Never logged. */
  storageState(): Promise<string>;

  listTabs(): Promise<{ index: number; url: string | null; title: string | null; active: boolean }[]>;
  openTab(url: string | null, signal: AbortSignal): Promise<number>;
  switchTab(index: number): Promise<void>;
  closeTab(index: number): Promise<void>;

  close(): Promise<void>;
}
