import type { ActionType, BackendInfo, ComputerAction, Screenshot, ScreenContext } from './types.js';

/**
 * What every computer-control backend must provide.
 *
 * The interface is deliberately narrow. A backend observes a screen and
 * performs normalized actions on it; it does not plan, does not talk to a
 * model, and does not decide what is allowed. Keeping those concerns out is
 * what lets a desktop, a browser viewport and a remote host be
 * interchangeable, and what keeps Meridian's model registry from ever
 * depending on a particular agent implementation.
 *
 * Operator shape informed by UI-TARS Desktop's operator abstraction:
 *   https://github.com/bytedance/UI-TARS-desktop
 */
export interface ComputerAgentBackend {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly surface: 'desktop' | 'browser' | 'remote';

  /** Which actions this backend can actually perform. */
  supportedActions(): ActionType[];

  /**
   * Whether the backend can be used right now, and if not, what would fix it.
   * Probed, never assumed from configuration.
   */
  health(): Promise<BackendInfo['health']>;

  /** The screen and the coordinate space model output should be scaled from. */
  screen(): Promise<ScreenContext>;

  /** Prepare for a session. Called once before any action. */
  open(): Promise<void>;

  execute(action: ComputerAction, signal: AbortSignal): Promise<string>;

  screenshot(signal: AbortSignal): Promise<Screenshot>;

  /** Release everything. Must be safe to call twice. */
  close(): Promise<void>;
}

export class BackendRegistry {
  private readonly backends = new Map<string, ComputerAgentBackend>();

  register(backend: ComputerAgentBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: string): ComputerAgentBackend | null {
    return this.backends.get(id) ?? null;
  }

  list(): ComputerAgentBackend[] {
    return [...this.backends.values()];
  }

  /**
   * Every backend with its live health and screen.
   *
   * Health is probed here rather than cached, because "is a display attached"
   * and "is the host agent connected" change without notice, and a backend
   * shown as ready that then fails on the first action is worse than one
   * shown as unavailable with a reason.
   */
  async describe(): Promise<BackendInfo[]> {
    return Promise.all(
      this.list().map(async (b) => {
        const health = await b.health().catch((e: unknown) => ({
          available: false,
          detail: e instanceof Error ? e.message : String(e),
          remediation: null,
          version: null,
        }));
        const screen = health.available ? await b.screen().catch(() => null) : null;
        return {
          id: b.id,
          name: b.name,
          description: b.description,
          surface: b.surface,
          supportedActions: b.supportedActions(),
          health,
          screen,
          needsGrounding: b.surface === 'desktop',
        };
      }),
    );
  }
}
