import { evaluate, validateAction } from './policy.js';
import type { BackendRegistry } from './backend.js';
import { SAFE_PERMISSIONS, type ComputerAction } from './types.js';

/**
 * Test mode.
 *
 * A user should be able to find out whether computer control will work
 * *before* pointing an agent at their machine and discovering that screenshots
 * fail three steps in. Each check does the real thing — takes a real
 * screenshot, moves the real pointer — rather than asserting configuration.
 *
 * Nothing here types, clicks or launches anything: a diagnostic that could
 * alter the machine would be a bad diagnostic.
 */

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  /** Set when the check could not run at all, as opposed to running and failing. */
  skipped: boolean;
}

export interface DiagnosticsResult {
  backendId: string | null;
  checks: DiagnosticCheck[];
  ok: boolean;
}

export async function runDiagnostics(registry: BackendRegistry, backendId?: string | null): Promise<DiagnosticsResult> {
  const checks: DiagnosticCheck[] = [];
  const timed = async (name: string, fn: () => Promise<string>): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail, durationMs: Date.now() - started, skipped: false });
    } catch (e) {
      checks.push({
        name,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
        skipped: false,
      });
    }
  };

  // The policy engine is pure and can always be exercised, so it is checked
  // first: if permissions are not being enforced, nothing else matters.
  await timed('Permission engine', async () => {
    const denied = evaluate({
      action: { type: 'type', text: 'hello' },
      permissions: { screen: true },
      approvalMode: 'autonomous',
    });
    if (denied.decision !== 'reject') throw new Error('typing was permitted without the keyboard permission');
    const allowed = evaluate({ action: { type: 'screenshot' }, permissions: SAFE_PERMISSIONS, approvalMode: 'autonomous' });
    if (allowed.decision !== 'allow') throw new Error('a screenshot was refused despite the screen permission');
    return 'denies actions without permission and allows those with it';
  });

  await timed('Action validation', async () => {
    const bad = validateAction({ type: 'click', to: { x: Number.NaN, y: 5 } } as unknown as ComputerAction);
    if (bad.ok) throw new Error('a NaN coordinate was accepted');
    const injection = validateAction({ type: 'open_application', name: 'x; rm -rf /' } as unknown as ComputerAction);
    if (injection.ok) throw new Error('an application name containing shell metacharacters was accepted');
    return 'rejects malformed coordinates and unsafe application names';
  });

  const backend = backendId ? registry.get(backendId) : null;
  const chosen = backend ?? (await firstAvailable(registry));

  if (!chosen) {
    checks.push({
      name: 'Backend',
      ok: false,
      detail: 'No computer-control backend is available on this machine.',
      durationMs: 0,
      skipped: false,
    });
    return { backendId: null, checks, ok: false };
  }

  await timed('Backend health', async () => {
    const health = await chosen.health();
    if (!health.available) throw new Error(`${health.detail ?? 'unavailable'}${health.remediation ? ` — ${health.remediation}` : ''}`);
    return health.version ?? 'available';
  });

  const healthy = checks[checks.length - 1]?.ok === true;
  if (!healthy) {
    for (const name of ['Screen capture', 'Pointer control', 'Screen geometry']) {
      checks.push({ name, ok: false, detail: 'skipped: the backend is not available', durationMs: 0, skipped: true });
    }
    return { backendId: chosen.id, checks, ok: false };
  }

  await chosen.open().catch(() => undefined);

  await timed('Screen geometry', async () => {
    const screen = await chosen.screen();
    if (!screen.width || !screen.height) throw new Error('the backend reported a zero-sized screen');
    return `${screen.width}x${screen.height}${screen.singleDisplayOnly ? ' (single display only)' : ''}`;
  });

  await timed('Screen capture', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const shot = await chosen.screenshot(controller.signal);
      if (!shot.data || shot.width <= 0) throw new Error('the capture was empty');
      return `captured ${shot.width}x${shot.height}, ${Math.round(shot.data.length / 1024)}KB`;
    } finally {
      clearTimeout(timer);
    }
  });

  await timed('Pointer control', async () => {
    // A move is the only input that changes nothing: it does not click, type
    // or activate anything, so it is safe to run as a diagnostic.
    const screen = await chosen.screen();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const target = { x: Math.round(screen.groundingWidth / 2), y: Math.round(screen.groundingHeight / 2) };
      return await chosen.execute({ type: 'move', to: target }, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });

  return { backendId: chosen.id, checks, ok: checks.every((c) => c.ok) };
}

async function firstAvailable(registry: BackendRegistry) {
  for (const b of registry.list()) {
    const health = await b.health().catch(() => ({ available: false }));
    if (health.available) return b;
  }
  return null;
}
