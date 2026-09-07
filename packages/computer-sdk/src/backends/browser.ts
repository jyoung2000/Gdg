import { randomUUID } from 'node:crypto';
import { MeridianError } from '@meridian/shared';
import type { BrowserManager } from '@meridian/browser-sdk';
import type { ComputerAgentBackend } from '../backend.js';
import { toScreenPoint, type ActionType, type BackendHealth, type ComputerAction, type Screenshot, type ScreenContext } from '../types.js';

/**
 * A browser page as a computer surface.
 *
 * The browser is a legitimate operator target, not a lesser substitute for a
 * desktop: UI-TARS Desktop treats browser and computer operators as peers for
 * exactly this reason. It matters practically too — this is the only surface
 * available on a headless server, so it is what makes computer control usable
 * in the deployment Meridian is most often run in.
 *
 * Operator peering informed by:
 *   https://github.com/bytedance/UI-TARS-desktop (browser-operator)
 *
 * Coordinates address the viewport, so the same grounded click that would land
 * on a desktop window lands on the page.
 */
export class BrowserComputerBackend implements ComputerAgentBackend {
  readonly id = 'browser';
  readonly name = 'Browser viewport';
  readonly description = 'Drives a browser page as the screen: real pointer and keyboard events at real coordinates.';
  readonly surface = 'browser' as const;

  private readonly manager: BrowserManager;
  private readonly viewport: { width: number; height: number };
  private readonly groundingWidth: number | null;
  private readonly groundingHeight: number | null;
  private sessionId: string | null = null;
  private readonly startUrl: string | null;

  constructor(opts: {
    manager: BrowserManager;
    viewport?: { width: number; height: number };
    groundingWidth?: number;
    groundingHeight?: number;
    startUrl?: string | null;
  }) {
    this.manager = opts.manager;
    this.viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.groundingWidth = opts.groundingWidth ?? null;
    this.groundingHeight = opts.groundingHeight ?? null;
    this.startUrl = opts.startUrl ?? null;
  }

  supportedActions(): ActionType[] {
    // No application launching: a page has no notion of starting a program,
    // and pretending otherwise would let a plan propose steps that can only
    // ever fail.
    return ['screenshot', 'move', 'click', 'double_click', 'right_click', 'drag', 'type', 'key_press', 'hotkey', 'scroll', 'wait', 'finish'];
  }

  async health(): Promise<BackendHealth> {
    const engines = await this.manager.engines();
    const usable = engines.find((e) => e.available);
    if (!usable) {
      const chromium = engines.find((e) => e.id === 'chromium');
      return {
        available: false,
        detail: chromium?.detail ?? 'No browser engine is available',
        remediation: chromium?.note ?? 'Install Chromium with `npx playwright install chromium`.',
        version: null,
      };
    }
    return { available: true, detail: null, remediation: null, version: `${usable.id} engine` };
  }

  async screen(): Promise<ScreenContext> {
    return {
      width: this.viewport.width,
      height: this.viewport.height,
      groundingWidth: this.groundingWidth ?? this.viewport.width,
      groundingHeight: this.groundingHeight ?? this.viewport.height,
      displays: 1,
      singleDisplayOnly: true,
    };
  }

  async open(): Promise<void> {
    if (this.sessionId) return;
    const info = await this.manager.createSession({
      engine: 'auto',
      task: 'computer agent surface',
      idleTimeoutMs: 15 * 60_000,
      viewport: this.viewport,
    });
    this.sessionId = info.id;
    if (this.startUrl) await this.manager.navigate(info.id, this.startUrl).catch(() => undefined);
  }

  private session(): string {
    if (!this.sessionId) throw new MeridianError('invalid_request', 'The browser surface is not open');
    return this.sessionId;
  }

  /**
   * Coordinate actions go through the raw input API rather than the ref-based
   * one, because a computer agent grounds against pixels it saw in a
   * screenshot — the same contract a desktop backend honours.
   */
  async execute(action: ComputerAction, signal: AbortSignal): Promise<string> {
    const id = this.session();
    const screen = await this.screen();
    const at = (p: { x: number; y: number }): { x: number; y: number } => toScreenPoint(p, screen);

    switch (action.type) {
      case 'screenshot': {
        const shot = await this.screenshot(signal);
        return `captured ${shot.width}x${shot.height}`;
      }
      case 'move': {
        const p = at(action.to);
        await this.manager.pointerMove(id, p.x, p.y);
        return `moved to ${p.x}, ${p.y}`;
      }
      case 'click': {
        const p = at(action.to);
        await this.manager.pointerClick(id, p.x, p.y, { button: action.button ?? 'left' });
        return `clicked at ${p.x}, ${p.y}`;
      }
      case 'double_click': {
        const p = at(action.to);
        await this.manager.pointerClick(id, p.x, p.y, { clickCount: 2 });
        return `double-clicked at ${p.x}, ${p.y}`;
      }
      case 'right_click': {
        const p = at(action.to);
        await this.manager.pointerClick(id, p.x, p.y, { button: 'right' });
        return `right-clicked at ${p.x}, ${p.y}`;
      }
      case 'drag': {
        const from = at(action.from);
        const to = at(action.to);
        await this.manager.pointerDrag(id, from, to);
        return `dragged ${from.x},${from.y} -> ${to.x},${to.y}`;
      }
      case 'type':
        await this.manager.typeText(id, action.text);
        return `typed ${action.text.length} character(s)`;
      case 'key_press':
        await this.manager.press(id, normalizeKey(action.key));
        return `pressed ${action.key}`;
      case 'hotkey':
        await this.manager.press(id, action.keys.map(normalizeKey).join('+'));
        return `pressed ${action.keys.join('+')}`;
      case 'scroll': {
        if (action.direction === 'left' || action.direction === 'right') {
          throw new MeridianError('unsupported_capability', 'Horizontal scrolling is not supported on this surface');
        }
        await this.manager.scroll(id, action.direction);
        return `scrolled ${action.direction}`;
      }
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(action.ms, 60_000)));
        return `waited ${action.ms}ms`;
      case 'open_application':
      case 'close_application':
        throw new MeridianError('unsupported_capability', 'A browser surface cannot start or stop applications');
      case 'finish':
        return action.summary;
    }
    void signal;
  }

  async screenshot(_signal: AbortSignal): Promise<Screenshot> {
    const shot = await this.manager.screenshot(this.session());
    return { id: `shot_${randomUUID().slice(0, 12)}`, data: shot.data, width: shot.width, height: shot.height, at: Date.now() };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    await this.manager.closeSession(id).catch(() => undefined);
  }
}

/** Meridian key names to the browser's own spelling. */
function normalizeKey(key: string): string {
  const map: Record<string, string> = {
    Return: 'Enter',
    Esc: 'Escape',
    Space: 'Space',
    Page_Up: 'PageUp',
    Page_Down: 'PageDown',
    ctrl: 'Control',
    control: 'Control',
    cmd: 'Meta',
    super: 'Meta',
    meta: 'Meta',
    alt: 'Alt',
    shift: 'Shift',
  };
  return map[key] ?? key;
}
