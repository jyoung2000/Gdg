/**
 * The computer-control vocabulary.
 *
 * Every model, every backend and every UI surface speaks these types, which is
 * what makes model and backend independent: Claude driving X11 and a local
 * model driving a browser viewport both produce the same `ComputerAction`, and
 * the same policy engine judges both.
 *
 * Action-space and operator shape informed by:
 *   https://github.com/bytedance/UI-TARS-desktop (operators, ScreenContext)
 *   https://github.com/simular-ai/Agent-S        (grounding, coordinate scaling)
 */

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

export const ACTION_TYPES = [
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
  'close_application',
  'finish',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** A point in the backend's own pixel space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * One normalized action.
 *
 * `rationale` is a short operational summary the UI shows ("Opening the
 * Downloads folder"). It is deliberately not the model's private reasoning:
 * the loop asks for a one-line description of the step, never for hidden
 * chain-of-thought.
 */
export type ComputerAction =
  | { type: 'screenshot'; rationale?: string }
  | { type: 'move'; to: Point; rationale?: string }
  | { type: 'click'; to: Point; button?: 'left' | 'middle' | 'right'; rationale?: string }
  | { type: 'double_click'; to: Point; rationale?: string }
  | { type: 'right_click'; to: Point; rationale?: string }
  | { type: 'drag'; from: Point; to: Point; rationale?: string }
  | { type: 'type'; text: string; rationale?: string }
  | { type: 'key_press'; key: string; rationale?: string }
  | { type: 'hotkey'; keys: string[]; rationale?: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; at?: Point; rationale?: string }
  | { type: 'wait'; ms: number; rationale?: string }
  | { type: 'open_application'; name: string; rationale?: string }
  | { type: 'close_application'; name: string; rationale?: string }
  | { type: 'finish'; summary: string; success: boolean; rationale?: string };

/**
 * The screen a backend presents, and how model coordinates map onto it.
 *
 * Models are trained to emit coordinates in a normalized space — often
 * 0..1000 — which is not the screen's pixel space. Carrying the scale here
 * rather than assuming 1:1 is what stops a grounded click from landing in the
 * wrong place on a display the model never saw the true size of.
 */
export interface ScreenContext {
  width: number;
  height: number;
  /** The space the model is asked to emit coordinates in. */
  groundingWidth: number;
  groundingHeight: number;
  /** Number of displays the backend can see; 1 when it cannot tell. */
  displays: number;
  /** True when this backend can only ever drive one display. */
  singleDisplayOnly: boolean;
}

/** Scale a model-space point onto the backend's real pixels. */
export function toScreenPoint(point: Point, screen: ScreenContext): Point {
  const sx = screen.width / (screen.groundingWidth || screen.width);
  const sy = screen.height / (screen.groundingHeight || screen.height);
  return {
    x: Math.max(0, Math.min(screen.width - 1, Math.round(point.x * sx))),
    y: Math.max(0, Math.min(screen.height - 1, Math.round(point.y * sy))),
  };
}

/* ------------------------------------------------------------------ */
/* Permissions                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a session is allowed to do.
 *
 * Deliberately finer than "computer access": reading the screen is not the
 * same power as deleting a file, and a session should be able to hold one
 * without the other. Everything defaults to denied.
 */
export const PERMISSIONS = [
  'screen',
  'mouse',
  'keyboard',
  'clipboard',
  'open_application',
  'browser',
  'terminal',
  'files_read',
  'files_write',
  'files_delete',
  'files_download',
  'files_upload',
  'mcp',
  'docker',
  'network',
  'remote_computer',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionSet = Partial<Record<Permission, boolean>>;

/** Nothing is permitted until something grants it. */
export const NO_PERMISSIONS: PermissionSet = {};

/** Look, do not touch: enough to observe, never to act. */
export const READ_ONLY_PERMISSIONS: PermissionSet = { screen: true };

/**
 * The safe default for an interactive computer session: see the screen and
 * drive the pointer and keyboard, with nothing that reaches the filesystem,
 * a shell, or the network on its own.
 */
export const SAFE_PERMISSIONS: PermissionSet = {
  screen: true,
  mouse: true,
  keyboard: true,
  open_application: true,
};

export function hasPermission(set: PermissionSet, permission: Permission): boolean {
  return set[permission] === true;
}

/* ------------------------------------------------------------------ */
/* Risk and approval                                                  */
/* ------------------------------------------------------------------ */

export const RISK_LEVELS = ['safe', 'elevated', 'destructive'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_MODES = ['every_action', 'risky_actions', 'autonomous'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** The verdict of the policy engine for one proposed action. */
export interface PolicyVerdict {
  decision: 'allow' | 'ask' | 'reject';
  risk: RiskLevel;
  /** Plain sentence shown to the user; never a code. */
  reason: string;
  /** The permission that decided it, when one did. */
  permission: Permission | null;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  action: ComputerAction;
  verdict: PolicyVerdict;
  /** What the user is actually approving, in words. */
  description: string;
  requestedAt: number;
  expiresAt: number;
}

/* ------------------------------------------------------------------ */
/* Sessions and events                                                */
/* ------------------------------------------------------------------ */

export const SESSION_STATES = ['starting', 'running', 'awaiting_approval', 'paused', 'stopping', 'completed', 'failed', 'stopped'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type GroundingMode = 'auto' | 'primary_model' | 'dedicated_model';

/**
 * Everything a session was started with.
 *
 * Snapshotted at creation, never re-read from live settings: a session run
 * with one model and backend must stay auditable after the defaults change.
 */
export interface SessionConfig {
  task: string;
  backendId: string;
  modelId: string | null;
  providerId: string | null;
  groundingMode: GroundingMode;
  groundingModelId: string | null;
  permissions: PermissionSet;
  approvalMode: ApprovalMode;
  maxSteps: number;
  actionTimeoutMs: number;
  /** Why this model/backend pair was chosen, when routing chose it. */
  routingReason: string | null;
  /** Fallbacks to try, in order, if the primary combination fails. */
  fallbackModelIds: string[];
  fallbackBackendIds: string[];
  profileId: string | null;
  workspaceId: string | null;
  privacyPreference: 'local_only' | 'prefer_local' | 'balanced' | 'prefer_cloud';
}

export interface ActionRecord {
  id: string;
  sessionId: string;
  step: number;
  action: ComputerAction;
  verdict: PolicyVerdict;
  status: 'proposed' | 'approved' | 'denied' | 'executing' | 'completed' | 'failed' | 'skipped';
  /** Backend result text, capped. */
  result: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Screenshot id captured after the action, when one was. */
  screenshotId: string | null;
}

export interface ComputerSessionInfo {
  id: string;
  state: SessionState;
  config: SessionConfig;
  /** The backend and model actually in use, which fallback can change. */
  activeBackendId: string;
  activeModelId: string | null;
  step: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  screen: ScreenContext | null;
  pendingApproval: PendingApproval | null;
}

/**
 * The event stream.
 *
 * Named to match the shapes the UI needs rather than the internals that
 * produce them, so a new backend cannot introduce a new event vocabulary.
 */
export type AgentEvent =
  | { type: 'agent.started'; sessionId: string; at: number; config: SessionConfig }
  | { type: 'agent.thinking'; sessionId: string; at: number; step: number; summary: string }
  | { type: 'agent.screenshot'; sessionId: string; at: number; screenshotId: string; width: number; height: number }
  | { type: 'agent.action.proposed'; sessionId: string; at: number; record: ActionRecord }
  | { type: 'agent.action.approval_required'; sessionId: string; at: number; approval: PendingApproval }
  | { type: 'agent.action.started'; sessionId: string; at: number; recordId: string }
  | { type: 'agent.action.completed'; sessionId: string; at: number; record: ActionRecord }
  | { type: 'agent.error'; sessionId: string; at: number; message: string; recoverable: boolean }
  | { type: 'agent.fallback'; sessionId: string; at: number; from: string; to: string; reason: string }
  | { type: 'agent.paused'; sessionId: string; at: number }
  | { type: 'agent.resumed'; sessionId: string; at: number }
  | { type: 'agent.stopped'; sessionId: string; at: number; reason: string }
  | { type: 'agent.completed'; sessionId: string; at: number; success: boolean; summary: string };

/* ------------------------------------------------------------------ */
/* Backends                                                           */
/* ------------------------------------------------------------------ */

export interface BackendHealth {
  available: boolean;
  /** Why it cannot be used, and what would fix it. */
  detail: string | null;
  remediation: string | null;
  /** Version or build string when the backend can report one. */
  version: string | null;
}

export interface BackendInfo {
  id: string;
  name: string;
  description: string;
  /** Where the actions land: this machine, a browser page, or another host. */
  surface: 'desktop' | 'browser' | 'remote';
  supportedActions: ActionType[];
  health: BackendHealth;
  screen: ScreenContext | null;
  /** True when the backend needs a dedicated grounding model to be useful. */
  needsGrounding: boolean;
}

export interface Screenshot {
  id: string;
  /** PNG bytes, base64. */
  data: string;
  width: number;
  height: number;
  at: number;
}
