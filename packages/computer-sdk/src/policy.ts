import {
  ACTION_TYPES,
  hasPermission,
  type ActionType,
  type ApprovalMode,
  type ComputerAction,
  type Permission,
  type PermissionSet,
  type PolicyVerdict,
  type RiskLevel,
} from './types.js';

/**
 * The action policy engine.
 *
 * Every proposed action passes through here before anything touches the host:
 *
 *   schema validation -> permission check -> risk classification -> approval
 *
 * The load-bearing rule is that this runs on Meridian's side of the boundary,
 * not the model's. The model is *told* its permissions (so it can plan
 * sensibly) but is never trusted to respect them — a model that emits a
 * `type` action with no keyboard permission is rejected here, not asked
 * nicely. That is the difference between a permission system and a prompt.
 */

/** Which permission each action type consumes. */
const REQUIRED_PERMISSION: Record<ActionType, Permission | null> = {
  screenshot: 'screen',
  move: 'mouse',
  click: 'mouse',
  double_click: 'mouse',
  right_click: 'mouse',
  drag: 'mouse',
  scroll: 'mouse',
  type: 'keyboard',
  key_press: 'keyboard',
  hotkey: 'keyboard',
  open_application: 'open_application',
  close_application: 'open_application',
  wait: null,
  finish: null,
};

/* ------------------------------------------------------------------ */
/* Schema validation                                                  */
/* ------------------------------------------------------------------ */

export interface ValidationResult {
  ok: boolean;
  error: string | null;
}

const MAX_TEXT = 10_000;
const MAX_WAIT_MS = 60_000;
/** Key names a backend will accept; anything else is a malformed action. */
const KEY_PATTERN = /^[A-Za-z0-9]{1,20}$|^(Return|Enter|Tab|Escape|Esc|Space|BackSpace|Delete|Home|End|Page_Up|Page_Down|Up|Down|Left|Right|F[1-9]|F1[0-2]|shift|ctrl|control|alt|super|meta|cmd)$/;

function point(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'must be a point {x, y}';
  const p = value as { x?: unknown; y?: unknown };
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return 'x must be a finite number';
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return 'y must be a finite number';
  if (p.x < 0 || p.y < 0) return 'coordinates must not be negative';
  return null;
}

/**
 * Reject anything malformed before it can reach a host executor.
 *
 * A grounding model that returns NaN, a negative coordinate or a 40KB "type"
 * payload is a normal failure mode, not an attack, and it has to fail here
 * rather than halfway through an X11 call.
 */
export function validateAction(action: unknown): ValidationResult {
  if (!action || typeof action !== 'object') return { ok: false, error: 'action must be an object' };
  const a = action as { type?: unknown } & Record<string, unknown>;
  if (typeof a.type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(a.type)) {
    return { ok: false, error: `unknown action type ${JSON.stringify(a.type)}` };
  }
  const fail = (error: string): ValidationResult => ({ ok: false, error });

  switch (a.type as ActionType) {
    case 'move':
    case 'click':
    case 'double_click':
    case 'right_click': {
      const err = point(a.to);
      if (err) return fail(`to: ${err}`);
      if (a.type === 'click' && a.button !== undefined && !['left', 'middle', 'right'].includes(String(a.button))) {
        return fail('button must be left, middle or right');
      }
      return { ok: true, error: null };
    }
    case 'drag': {
      const from = point(a.from);
      if (from) return fail(`from: ${from}`);
      const to = point(a.to);
      if (to) return fail(`to: ${to}`);
      return { ok: true, error: null };
    }
    case 'scroll': {
      if (!['up', 'down', 'left', 'right'].includes(String(a.direction))) return fail('direction must be up, down, left or right');
      if (a.amount !== undefined && (typeof a.amount !== 'number' || a.amount < 0 || a.amount > 100)) {
        return fail('amount must be between 0 and 100');
      }
      if (a.at !== undefined) {
        const err = point(a.at);
        if (err) return fail(`at: ${err}`);
      }
      return { ok: true, error: null };
    }
    case 'type': {
      if (typeof a.text !== 'string') return fail('text must be a string');
      if (a.text.length > MAX_TEXT) return fail(`text exceeds ${MAX_TEXT} characters`);
      return { ok: true, error: null };
    }
    case 'key_press': {
      if (typeof a.key !== 'string' || !KEY_PATTERN.test(a.key)) return fail(`"${String(a.key)}" is not a recognised key name`);
      return { ok: true, error: null };
    }
    case 'hotkey': {
      if (!Array.isArray(a.keys) || a.keys.length === 0 || a.keys.length > 5) return fail('keys must be 1-5 key names');
      for (const k of a.keys) if (typeof k !== 'string' || !KEY_PATTERN.test(k)) return fail(`"${String(k)}" is not a recognised key name`);
      return { ok: true, error: null };
    }
    case 'wait': {
      if (typeof a.ms !== 'number' || a.ms < 0 || a.ms > MAX_WAIT_MS) return fail(`ms must be between 0 and ${MAX_WAIT_MS}`);
      return { ok: true, error: null };
    }
    case 'open_application':
    case 'close_application': {
      if (typeof a.name !== 'string' || !a.name.trim()) return fail('name is required');
      // The name reaches a process launcher. Anything that could be read as
      // shell metacharacters is refused outright rather than escaped, because
      // an application name never legitimately contains them.
      if (!/^[A-Za-z0-9 ._+-]{1,64}$/.test(a.name)) return fail('application name may only contain letters, digits, spaces and . _ + -');
      return { ok: true, error: null };
    }
    case 'finish': {
      if (typeof a.summary !== 'string') return fail('summary must be a string');
      if (typeof a.success !== 'boolean') return fail('success must be a boolean');
      return { ok: true, error: null };
    }
    case 'screenshot':
      return { ok: true, error: null };
  }
}

/* ------------------------------------------------------------------ */
/* Risk classification                                                */
/* ------------------------------------------------------------------ */

/**
 * Text patterns that make an otherwise ordinary action consequential.
 *
 * Typing is usually harmless; typing `rm -rf` into a terminal is not, and the
 * action type alone cannot tell the difference. These are heuristics and are
 * treated as such: they can only raise the risk level, never lower it.
 */
const DESTRUCTIVE_TEXT = [
  /\brm\s+-[rf]/i,
  /\bdel\s+\/[sq]/i,
  /\bformat\s+[a-z]:/i,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b/i,
  /\bchmod\s+777\b/i,
  /:\s*>\s*\/dev\/sd/i,
];

const ELEVATED_TEXT = [
  /\bsudo\b|\bsu\s|\brunas\b/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\bpassword\b|\bapi[_ -]?key\b|\bsecret\b|\btoken\b/i,
  /\bsend\b|\bpost\b|\bpublish\b|\btweet\b/i,
  /\bbuy\b|\bpurchase\b|\bcheckout\b|\bpay\b/i,
  /\btransfer\b|\bwire\b/i,
];

/** Hotkeys that destroy or escape, rather than navigate. */
const ELEVATED_HOTKEYS = [
  ['ctrl', 'w'],
  ['ctrl', 'q'],
  ['alt', 'F4'],
  ['ctrl', 'alt', 'Delete'],
];

export function classifyRisk(action: ComputerAction): { risk: RiskLevel; reason: string } {
  switch (action.type) {
    case 'screenshot':
    case 'move':
    case 'wait':
    case 'scroll':
    case 'finish':
      return { risk: 'safe', reason: 'observes or moves without changing anything' };

    case 'click':
    case 'double_click':
    case 'right_click':
    case 'drag':
      // A click can do anything the thing under it does, but Meridian cannot
      // know what that is from coordinates alone. Treated as safe by type and
      // governed by the mouse permission and the approval mode instead.
      return { risk: 'safe', reason: 'a pointer action; what it activates depends on the screen' };

    case 'type': {
      for (const pattern of DESTRUCTIVE_TEXT) {
        if (pattern.test(action.text)) return { risk: 'destructive', reason: 'the text being typed looks destructive' };
      }
      for (const pattern of ELEVATED_TEXT) {
        if (pattern.test(action.text)) return { risk: 'elevated', reason: 'the text being typed looks consequential' };
      }
      return { risk: 'safe', reason: 'ordinary text entry' };
    }

    case 'key_press':
      return action.key === 'Return' || action.key === 'Enter'
        ? { risk: 'elevated', reason: 'Enter commits whatever is currently entered' }
        : { risk: 'safe', reason: 'a single key' };

    case 'hotkey': {
      const keys = action.keys.map((k) => k.toLowerCase());
      const match = ELEVATED_HOTKEYS.some((combo) => combo.length === keys.length && combo.every((k, i) => k.toLowerCase() === keys[i]));
      return match ? { risk: 'elevated', reason: 'this shortcut closes or interrupts an application' } : { risk: 'safe', reason: 'a keyboard shortcut' };
    }

    case 'open_application':
      return { risk: 'elevated', reason: 'starts a program' };

    case 'close_application':
      return { risk: 'elevated', reason: 'closes a program, which may discard unsaved work' };
  }
}

/* ------------------------------------------------------------------ */
/* The evaluator                                                      */
/* ------------------------------------------------------------------ */

export interface PolicyInput {
  action: ComputerAction;
  permissions: PermissionSet;
  approvalMode: ApprovalMode;
  /** Approvals the user granted for the rest of this task, by action type. */
  blanketApprovals?: Set<ActionType>;
  /** Actions the backend cannot perform at all. */
  supportedActions?: ActionType[];
}

/**
 * Decide what happens to one proposed action.
 *
 * Order matters and is deliberate: a malformed action is rejected before its
 * permission is considered, and a permission it does not hold is rejected
 * before its risk is weighed — so a denied action never appears in an
 * approval dialog, which would invite the user to grant something the session
 * was configured not to have.
 */
export function evaluate(input: PolicyInput): PolicyVerdict {
  const { action, permissions, approvalMode } = input;

  const validation = validateAction(action);
  if (!validation.ok) {
    return { decision: 'reject', risk: 'safe', reason: `Malformed action: ${validation.error}`, permission: null };
  }

  if (input.supportedActions && !input.supportedActions.includes(action.type)) {
    return {
      decision: 'reject',
      risk: 'safe',
      reason: `This backend cannot perform "${action.type}"`,
      permission: null,
    };
  }

  const required = REQUIRED_PERMISSION[action.type];
  if (required && !hasPermission(permissions, required)) {
    return {
      decision: 'reject',
      risk: 'safe',
      reason: `This session does not have the "${required}" permission`,
      permission: required,
    };
  }

  const { risk, reason } = classifyRisk(action);

  // `finish` ends the loop and touches nothing; making it approvable would
  // mean a session could never terminate without a human present.
  if (action.type === 'finish') {
    return { decision: 'allow', risk, reason, permission: null };
  }

  if (input.blanketApprovals?.has(action.type) && risk !== 'destructive') {
    return { decision: 'allow', risk, reason: `${reason} (approved for this task)`, permission: required };
  }

  // Destructive actions always ask, whatever the mode. Autonomous means "do
  // not interrupt me for ordinary steps", not "delete without asking".
  if (risk === 'destructive') {
    return { decision: 'ask', risk, reason, permission: required };
  }

  switch (approvalMode) {
    case 'every_action':
      return { decision: 'ask', risk, reason, permission: required };
    case 'risky_actions':
      return { decision: risk === 'elevated' ? 'ask' : 'allow', risk, reason, permission: required };
    case 'autonomous':
      return { decision: 'allow', risk, reason, permission: required };
  }
}

/**
 * A sentence describing exactly what the user is approving.
 *
 * Vague dialogs ("the agent wants to continue") train people to click Approve
 * without reading. The description always names the concrete operation.
 */
export function describeAction(action: ComputerAction): string {
  switch (action.type) {
    case 'screenshot':
      return 'Take a screenshot of the screen';
    case 'move':
      return `Move the pointer to ${action.to.x}, ${action.to.y}`;
    case 'click':
      return `${action.button === 'right' ? 'Right-click' : action.button === 'middle' ? 'Middle-click' : 'Click'} at ${action.to.x}, ${action.to.y}`;
    case 'double_click':
      return `Double-click at ${action.to.x}, ${action.to.y}`;
    case 'right_click':
      return `Right-click at ${action.to.x}, ${action.to.y}`;
    case 'drag':
      return `Drag from ${action.from.x}, ${action.from.y} to ${action.to.x}, ${action.to.y}`;
    case 'type':
      return `Type: ${JSON.stringify(action.text.length > 200 ? `${action.text.slice(0, 200)}…` : action.text)}`;
    case 'key_press':
      return `Press ${action.key}`;
    case 'hotkey':
      return `Press ${action.keys.join(' + ')}`;
    case 'scroll':
      return `Scroll ${action.direction}${action.at ? ` at ${action.at.x}, ${action.at.y}` : ''}`;
    case 'wait':
      return `Wait ${action.ms}ms`;
    case 'open_application':
      return `Open the application "${action.name}"`;
    case 'close_application':
      return `Close the application "${action.name}"`;
    case 'finish':
      return `Finish: ${action.summary}`;
  }
}
