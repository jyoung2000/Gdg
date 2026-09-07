import { spawn } from 'node:child_process';
import { MeridianError } from '@meridian/shared';
import type { ComputerAgentBackend } from '../backend.js';
import type { ActionType, BackendHealth, ComputerAction, Screenshot, ScreenContext } from '../types.js';

/**
 * Adapters for computer-use agents that ship as separate programs.
 *
 * Agent-S and UI-TARS are Python/Electron applications with their own runtimes,
 * models and installation stories. Vendoring either into Meridian would be a
 * dependency Meridian cannot honestly maintain, so instead each is detected on
 * PATH and reported with what is missing and how to install it. When present,
 * the adapter drives it as an external process.
 *
 *   https://github.com/simular-ai/Agent-S       (gui_agents, `agent_s` CLI)
 *   https://github.com/bytedance/UI-TARS-desktop
 *
 * Being explicit matters more than being optimistic here: a backend shown as
 * ready that fails on the first action is worse than one shown as unavailable
 * with an install command next to it.
 */

async function probeCommand(command: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, output: 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out = `${out}${d.toString()}`.slice(0, 2000);
    });
    child.stderr.on('data', (d: Buffer) => {
      out = `${out}${d.toString()}`.slice(0, 2000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, output: 'not found' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
  });
}

/**
 * A backend that is present only when its program is installed.
 *
 * The unavailable path is the interesting one, and it is the one that runs on
 * a machine without the agent installed: it must state what is missing and how
 * to get it, never merely "unavailable".
 */
abstract class ExternalAgentBackend implements ComputerAgentBackend {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  readonly surface = 'desktop' as const;
  protected abstract readonly command: string;
  protected abstract readonly versionArgs: string[];
  protected abstract readonly installHint: string;

  private cached: { at: number; health: BackendHealth } | null = null;

  supportedActions(): ActionType[] {
    return ['screenshot', 'move', 'click', 'double_click', 'right_click', 'drag', 'type', 'key_press', 'hotkey', 'scroll', 'wait', 'open_application', 'finish'];
  }

  async health(): Promise<BackendHealth> {
    // Probing spawns a process; a short cache keeps a settings page that lists
    // several backends from forking one per render.
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.health;
    const probe = await probeCommand(this.command, this.versionArgs);
    const health: BackendHealth = probe.ok
      ? { available: true, detail: null, remediation: null, version: probe.output.split('\n')[0]?.slice(0, 120) ?? null }
      : {
          available: false,
          detail: `${this.command} is not installed or did not respond.`,
          remediation: this.installHint,
          version: null,
        };
    this.cached = { at: Date.now(), health };
    return health;
  }

  async screen(): Promise<ScreenContext> {
    throw new MeridianError('unsupported_capability', `${this.name} is not connected`);
  }

  async open(): Promise<void> {
    const health = await this.health();
    if (!health.available) {
      throw new MeridianError('unsupported_capability', `${this.name} is not available: ${health.detail} ${health.remediation ?? ''}`.trim());
    }
    throw new MeridianError(
      'unsupported_capability',
      `${this.name} is installed but Meridian's adapter for driving it as a session backend is not implemented. Use the native or browser backend, or drive ${this.name} directly.`,
    );
  }

  async execute(_action: ComputerAction): Promise<string> {
    throw new MeridianError('unsupported_capability', `${this.name} is not connected`);
  }

  async screenshot(): Promise<Screenshot> {
    throw new MeridianError('unsupported_capability', `${this.name} is not connected`);
  }

  async close(): Promise<void> {
    /* nothing held */
  }
}

export class AgentSBackend extends ExternalAgentBackend {
  readonly id = 'agent-s';
  readonly name = 'Agent-S';
  readonly description = 'Simular\'s Agent-S GUI agent, driven as an external program when it is installed.';
  protected readonly command = process.env.MERIDIAN_AGENT_S_BIN ?? 'agent_s';
  protected readonly versionArgs = ['--help'];
  protected readonly installHint =
    'Install Agent-S (pip install gui-agents) and make `agent_s` available on the gateway\'s PATH, or set MERIDIAN_AGENT_S_BIN.';
}

export class UITarsBackend extends ExternalAgentBackend {
  readonly id = 'ui-tars';
  readonly name = 'UI-TARS';
  readonly description = 'ByteDance\'s UI-TARS desktop agent, driven as an external program when it is installed.';
  protected readonly command = process.env.MERIDIAN_UI_TARS_BIN ?? 'ui-tars';
  protected readonly versionArgs = ['--version'];
  protected readonly installHint =
    'Install UI-TARS Desktop and expose its CLI as `ui-tars` on the gateway\'s PATH, or set MERIDIAN_UI_TARS_BIN. UI-TARS can also be used as a grounding model through any OpenAI-compatible endpoint, which needs no backend here.';
}
