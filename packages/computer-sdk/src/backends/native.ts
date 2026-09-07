import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeridianError } from '@meridian/shared';
import { abortableSleep, type ComputerAgentBackend } from '../backend.js';
import { toScreenPoint, type ActionType, type BackendHealth, type ComputerAction, type Screenshot, type ScreenContext } from '../types.js';

/**
 * The local desktop, driven through X11.
 *
 * Input goes through the XTest extension and capture through Pillow, which is
 * the same layer pyautogui uses and therefore the same layer Agent-S drives:
 *   https://github.com/simular-ai/Agent-S
 *
 * The work happens in a small helper process (helper/xagent.py) rather than
 * inline, for two reasons: the Python X bindings are where the mature
 * implementations live, and putting the privileged operations in one short,
 * auditable file with no shell and no eval is easier to reason about than
 * scattering them through the gateway.
 */

const HELPER = resolveHelper();
const REQUEST_TIMEOUT_MS = 20_000;
/** Screenshots stream on every step; a full-res PNG per step is wasteful. */
const DEFAULT_MAX_SCREENSHOT_WIDTH = 1280;

function resolveHelper(): string {
  // Works both from source (packages/computer-sdk/src/backends) and from a
  // bundle, where the helper sits beside the built output.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '..', '..', 'helper', 'xagent.py'),
    join(here, '..', 'helper', 'xagent.py'),
    resolve(process.cwd(), 'packages/computer-sdk/helper/xagent.py'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, '..', '..', 'helper', 'xagent.py');
}

export interface NativeBackendOptions {
  /** X display to drive. Defaults to MERIDIAN_DISPLAY or DISPLAY. */
  display?: string | null;
  /** Python interpreter with Pillow and python-xlib available. */
  python?: string | null;
  /** The coordinate space models are asked to emit; defaults to real pixels. */
  groundingWidth?: number;
  groundingHeight?: number;
  maxScreenshotWidth?: number;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class NativeComputerBackend implements ComputerAgentBackend {
  readonly id = 'native';
  readonly name = 'Native desktop';
  readonly description = 'Drives this machine’s desktop directly: real pointer, real keyboard, real screen capture.';
  readonly surface = 'desktop' as const;

  private readonly opts: NativeBackendOptions;
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private readonly pending = new Map<string, Pending>();
  private ready: Promise<{ width: number; height: number }> | null = null;
  private size: { width: number; height: number } | null = null;
  private closed = false;
  /**
   * Sessions currently holding the helper open.
   *
   * Without this, probing health would spawn a helper and leave it running for
   * the life of the gateway — a process able to synthesise keystrokes, alive
   * while the UI truthfully says no session is running.
   */
  private users = 0;
  /**
   * Every helper this backend has spawned that has not exited.
   *
   * Tracking the set rather than only the current child is what makes shutdown
   * total: a probe and a session open can interleave such that a second helper
   * is spawned while `child` still points at the first, and killing only the
   * tracked one leaves a process holding the display behind.
   */
  private readonly children = new Set<ChildProcess>();

  constructor(opts: NativeBackendOptions = {}) {
    this.opts = opts;
  }

  private display(): string | null {
    return this.opts.display ?? process.env.MERIDIAN_DISPLAY ?? process.env.DISPLAY ?? null;
  }

  private python(): string {
    return this.opts.python ?? process.env.MERIDIAN_PYTHON ?? 'python3';
  }

  supportedActions(): ActionType[] {
    return [
      'screenshot',
      'move',
      'click',
      'double_click',
      'right_click',
      'drag',
      'type',
      'key_press',
      'hotkey',
      'scroll',
      'wait',
      'open_application',
      'finish',
    ];
  }

  async health(): Promise<BackendHealth> {
    const display = this.display();
    if (!display) {
      return {
        available: false,
        detail: 'No X display is configured for the gateway process.',
        remediation:
          'Set DISPLAY (or MERIDIAN_DISPLAY) to a display this process can reach. Inside a container this normally means running a host agent instead — a container cannot drive the host desktop without one.',
        version: null,
      };
    }
    if (!existsSync(HELPER)) {
      return { available: false, detail: `The X helper is missing at ${HELPER}.`, remediation: 'Reinstall Meridian.', version: null };
    }
    try {
      const size = await this.start();
      // A probe must leave the machine as it found it.
      if (this.users === 0) await this.shutdown();
      return { available: true, detail: null, remediation: null, version: `X11 ${size.width}x${size.height} on ${display}` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        available: false,
        detail: message,
        remediation: /missing python deps/.test(message)
          ? 'Install the helper dependencies: pip install pillow python-xlib (or set MERIDIAN_PYTHON to an interpreter that has them).'
          : `Check that ${display} exists and this process may connect to it.`,
        version: null,
      };
    }
  }

  async screen(): Promise<ScreenContext> {
    // The geometry is remembered across a probe, so describing the backend does
    // not have to start a second helper just to restate the screen size.
    const size = this.size ?? (await this.probeSize());
    return {
      width: size.width,
      height: size.height,
      groundingWidth: this.opts.groundingWidth ?? size.width,
      groundingHeight: this.opts.groundingHeight ?? size.height,
      // X reports one logical screen here; a multi-head setup appears as one
      // large screen rather than as separate displays this backend can pick
      // between, so it says so rather than implying a display selector works.
      displays: 1,
      singleDisplayOnly: true,
    };
  }

  async open(): Promise<void> {
    this.users += 1;
    await this.start();
  }

  /** There is one desktop, so every session drives this same instance. */
  forSession(): ComputerAgentBackend {
    return this;
  }

  /** Read the geometry without taking ownership of the helper. */
  private async probeSize(): Promise<{ width: number; height: number }> {
    const size = await this.start();
    if (this.users === 0) await this.shutdown();
    return size;
  }

  private start(): Promise<{ width: number; height: number }> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolvePromise, reject) => {
      const display = this.display();
      if (!display) {
        reject(new MeridianError('unsupported_capability', 'No X display is configured'));
        return;
      }
      const child = spawn(this.python(), [HELPER], {
        env: { ...process.env, DISPLAY: display, MERIDIAN_DISPLAY: display, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      this.child = child;
      this.children.add(child);
      this.closed = false;

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr = `${stderr}${d.toString()}`.slice(-2000);
      });
      child.on('error', (e) => {
        this.failAll(new MeridianError('server_error', `Could not start the X helper: ${e.message}`));
        reject(e);
      });
      child.on('exit', (code, signal) => {
        this.children.delete(child);
        const error = new MeridianError('server_error', `The X helper exited (${signal ?? code})${stderr ? `: ${stderr.slice(-300)}` : ''}`);
        this.failAll(error);
        this.ready = null;
        if (!this.size) reject(error);
      });

      const rl = createInterface({ input: child.stdout! });
      this.rl = rl;
      let handshake = false;
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!handshake) {
          handshake = true;
          if (msg.ok === true && msg.ready === true) {
            this.size = { width: Number(msg.width), height: Number(msg.height) };
            resolvePromise(this.size);
          } else {
            reject(new MeridianError('unsupported_capability', String(msg.fatal ?? 'the X helper failed to start')));
          }
          return;
        }
        const id = typeof msg.id === 'string' ? msg.id : null;
        if (!id) return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve(msg);
        else p.reject(new MeridianError('server_error', String(msg.error ?? 'helper error')));
      });

      // A helper that never completes its handshake must not hang the caller.
      const bootTimer = setTimeout(() => {
        if (!handshake) {
          child.kill('SIGKILL');
          reject(new MeridianError('timeout', 'The X helper did not start within 15s'));
        }
      }, 15_000);
      bootTimer.unref?.();
    });
    return this.ready;
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private async request(op: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.start();
    if (signal?.aborted) throw new MeridianError('cancelled', 'Action cancelled');
    const id = randomUUID().slice(0, 12);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MeridianError('timeout', `The ${op} action did not complete within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });

      const onAbort = (): void => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(new MeridianError('cancelled', 'Action cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.child!.stdin!.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  async execute(action: ComputerAction, signal: AbortSignal): Promise<string> {
    const screen = await this.screen();
    const at = (p: { x: number; y: number }): { x: number; y: number } => toScreenPoint(p, screen);

    switch (action.type) {
      case 'screenshot': {
        const shot = await this.screenshot(signal);
        return `captured ${shot.width}x${shot.height}`;
      }
      case 'move': {
        const p = at(action.to);
        await this.request('move', p, signal);
        return `moved to ${p.x}, ${p.y}`;
      }
      case 'click': {
        const p = at(action.to);
        const button = action.button === 'right' ? 3 : action.button === 'middle' ? 2 : 1;
        await this.request('click', { ...p, button, count: 1 }, signal);
        return `clicked at ${p.x}, ${p.y}`;
      }
      case 'double_click': {
        const p = at(action.to);
        await this.request('click', { ...p, button: 1, count: 2 }, signal);
        return `double-clicked at ${p.x}, ${p.y}`;
      }
      case 'right_click': {
        const p = at(action.to);
        await this.request('click', { ...p, button: 3, count: 1 }, signal);
        return `right-clicked at ${p.x}, ${p.y}`;
      }
      case 'drag': {
        const from = at(action.from);
        const to = at(action.to);
        await this.request('drag', { x1: from.x, y1: from.y, x2: to.x, y2: to.y }, signal);
        return `dragged ${from.x},${from.y} -> ${to.x},${to.y}`;
      }
      case 'type':
        await this.request('type', { text: action.text }, signal);
        return `typed ${action.text.length} character(s)`;
      case 'key_press':
        await this.request('key', { key: action.key }, signal);
        return `pressed ${action.key}`;
      case 'hotkey':
        await this.request('hotkey', { keys: action.keys }, signal);
        return `pressed ${action.keys.join('+')}`;
      case 'scroll': {
        const payload: Record<string, unknown> = { direction: action.direction, amount: action.amount ?? 3 };
        if (action.at) payload.at = [at(action.at).x, at(action.at).y];
        await this.request('scroll', payload, signal);
        return `scrolled ${action.direction}`;
      }
      case 'wait':
        await abortableSleep(Math.min(action.ms, 60_000), signal);
        return `waited ${action.ms}ms`;
      case 'open_application': {
        const res = await this.request('open', { name: action.name }, signal);
        return `launched ${String(res.path ?? action.name)}`;
      }
      case 'close_application':
        throw new MeridianError('unsupported_capability', 'This backend cannot close applications; use a window-manager hotkey instead');
      case 'finish':
        return action.summary;
    }
  }

  async screenshot(signal: AbortSignal): Promise<Screenshot> {
    const res = await this.request('screenshot', { maxWidth: this.opts.maxScreenshotWidth ?? DEFAULT_MAX_SCREENSHOT_WIDTH }, signal);
    return {
      id: `shot_${randomUUID().slice(0, 12)}`,
      data: String(res.data ?? ''),
      width: Number(res.width ?? 0),
      height: Number(res.height ?? 0),
      at: Date.now(),
    };
  }

  async close(): Promise<void> {
    this.users = Math.max(0, this.users - 1);
    // Another session still needs the helper; tearing it down here would end
    // that session's control mid-task.
    if (this.users > 0) return;
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.children.size === 0) return;
    this.closed = true;
    this.failAll(new MeridianError('cancelled', 'Backend closed'));
    this.rl?.close();
    this.child = null;
    this.ready = null;
    for (const child of [...this.children]) {
      this.children.delete(child);
      child.stdin?.end();
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killer.unref?.();
      // The handle keeps the event loop alive until the process is reaped;
      // nothing is waiting on this one, so it must not hold the gateway open.
      child.unref?.();
    }
  }
}
