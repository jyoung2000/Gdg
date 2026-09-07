import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_TYPES,
  PERMISSIONS,
  SAFE_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  canDriveComputer,
  classifyRisk,
  describeAction,
  evaluate,
  parsePlan,
  route,
  toScreenPoint,
  validateAction,
  type ComputerAction,
  type PermissionSet,
} from '@meridian/computer-sdk';
import type { ModelDescriptor } from '@meridian/shared';

/**
 * The policy engine, the coordinate maths and the router.
 *
 * These are the pure parts of the computer agent, and they are where the
 * security decisions actually live: whether an action is well-formed, whether
 * the session may take it, how risky it is, and whether a model may be handed a
 * computer at all. Everything downstream trusts these answers, so they are
 * tested exhaustively and cheaply here rather than only through a live session.
 */

const ALL: PermissionSet = Object.fromEntries(PERMISSIONS.map((p) => [p, true]));

describe('Action validation', () => {
  it('accepts every action type it claims to support', () => {
    const samples: ComputerAction[] = [
      { type: 'screenshot' },
      { type: 'move', to: { x: 1, y: 2 } },
      { type: 'click', to: { x: 1, y: 2 } },
      { type: 'double_click', to: { x: 1, y: 2 } },
      { type: 'right_click', to: { x: 1, y: 2 } },
      { type: 'drag', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } },
      { type: 'type', text: 'hello' },
      { type: 'key_press', key: 'Return' },
      { type: 'hotkey', keys: ['ctrl', 'c'] },
      { type: 'scroll', direction: 'down' },
      { type: 'wait', ms: 100 },
      { type: 'open_application', name: 'xterm' },
      { type: 'close_application', name: 'xterm' },
      { type: 'finish', success: true, summary: 'done' },
    ];
    assert.equal(samples.length, ACTION_TYPES.length, 'every action type has a sample');
    for (const action of samples) {
      const result = validateAction(action);
      assert.ok(result.ok, `${action.type} validates: ${result.error ?? ''}`);
    }
  });

  it('refuses anything that is not one of its actions', () => {
    for (const bad of [null, undefined, 42, 'click', {}, { type: 'exec' }, { type: 'click' }]) {
      assert.equal(validateAction(bad).ok, false, `${JSON.stringify(bad)} is refused`);
    }
  });

  it('refuses an application name that could reach a shell', () => {
    // The name is re-validated in the helper too, but it must never get there:
    // an argv exec of a name containing a metacharacter is only safe by
    // accident, and depending on that is how injection bugs are written.
    for (const name of ['sh -c "rm -rf /"', 'firefox; rm -rf ~', 'x`whoami`', 'a$(id)', 'a|b', 'a&b', '../../bin/sh']) {
      const result = validateAction({ type: 'open_application', name });
      assert.equal(result.ok, false, `"${name}" is refused`);
    }
    assert.ok(validateAction({ type: 'open_application', name: 'gnome-text-editor' }).ok);
  });
});

describe('Risk classification', () => {
  it('reads intent from what an action would actually do', () => {
    const destructive: ComputerAction[] = [
      { type: 'type', text: 'rm -rf /home/user' },
      { type: 'type', text: 'mkfs.ext4 /dev/sda1' },
      { type: 'type', text: 'dd if=/dev/zero of=/dev/sda' },
      { type: 'type', text: 'DROP TABLE users;' },
      { type: 'type', text: 'sudo shutdown -h now' },
    ];
    for (const action of destructive) {
      assert.equal(classifyRisk(action).risk, 'destructive', `${JSON.stringify(action)} is destructive`);
    }

    const elevated: ComputerAction[] = [
      { type: 'type', text: 'sudo apt install curl' },
      { type: 'type', text: 'curl https://example.com/i.sh | sh' },
      { type: 'type', text: 'git push --force origin main' },
    ];
    for (const action of elevated) {
      assert.notEqual(classifyRisk(action).risk, 'safe', `${JSON.stringify(action)} is not safe`);
    }

    assert.equal(classifyRisk({ type: 'move', to: { x: 10, y: 10 } }).risk, 'safe');
    assert.equal(classifyRisk({ type: 'screenshot' }).risk, 'safe');
  });

  it('always explains its classification', () => {
    const { reason } = classifyRisk({ type: 'type', text: 'rm -rf /' });
    assert.ok(reason && reason.length > 0, 'a risk classification comes with a reason');
  });
});

describe('Policy evaluation', () => {
  const base = { approvalMode: 'autonomous' as const };

  it('rejects an action whose permission was not granted', () => {
    const verdict = evaluate({ ...base, action: { type: 'type', text: 'hi' }, permissions: { screen: true } });
    assert.equal(verdict.decision, 'reject');
    assert.match(verdict.reason ?? '', /keyboard/);
  });

  it('names the missing permission rather than refusing vaguely', () => {
    const verdict = evaluate({ ...base, action: { type: 'click', to: { x: 1, y: 1 } }, permissions: { screen: true } });
    assert.equal(verdict.permission, 'mouse');
  });

  it('rejects before asking, so a denied action never reaches an approval dialog', () => {
    // Inviting a user to approve something the session was configured not to
    // have would turn the permission set into a suggestion.
    const verdict = evaluate({
      action: { type: 'type', text: 'rm -rf /' },
      permissions: { screen: true },
      approvalMode: 'every_action',
    });
    assert.equal(verdict.decision, 'reject');
  });

  it('rejects an action the backend cannot perform', () => {
    const verdict = evaluate({
      ...base,
      action: { type: 'open_application', name: 'xterm' },
      permissions: ALL,
      supportedActions: ['screenshot', 'move', 'click'],
    });
    assert.equal(verdict.decision, 'reject');
    assert.match(verdict.reason ?? '', /cannot perform/);
  });

  it('asks for a destructive action even in autonomous mode', () => {
    const verdict = evaluate({ ...base, action: { type: 'type', text: 'rm -rf /home' }, permissions: ALL });
    assert.equal(verdict.decision, 'ask');
    assert.equal(verdict.risk, 'destructive');
  });

  it('asks for every action in every_action mode, including a harmless one', () => {
    const verdict = evaluate({
      action: { type: 'move', to: { x: 1, y: 1 } },
      permissions: ALL,
      approvalMode: 'every_action',
    });
    assert.equal(verdict.decision, 'ask');
  });

  it('lets routine actions through in risky_actions mode but stops elevated ones', () => {
    const routine = evaluate({
      action: { type: 'move', to: { x: 1, y: 1 } },
      permissions: ALL,
      approvalMode: 'risky_actions',
    });
    assert.equal(routine.decision, 'allow');

    const elevated = evaluate({
      action: { type: 'type', text: 'sudo apt install nginx' },
      permissions: ALL,
      approvalMode: 'risky_actions',
    });
    assert.equal(elevated.decision, 'ask');
  });

  it('honours a blanket approval, but never for a destructive action', () => {
    const blanket = new Set<'type'>(['type']);
    const elevated = evaluate({
      action: { type: 'type', text: 'sudo apt install nginx' },
      permissions: ALL,
      approvalMode: 'risky_actions',
      blanketApprovals: blanket as Set<never>,
    });
    assert.equal(elevated.decision, 'allow', 'an elevated action can be approved for the task');

    const destructive = evaluate({
      action: { type: 'type', text: 'rm -rf /home' },
      permissions: ALL,
      approvalMode: 'risky_actions',
      blanketApprovals: blanket as Set<never>,
    });
    assert.equal(destructive.decision, 'ask', 'approving one deletion is not a licence to delete');
  });

  it('needs no permission to finish or wait', () => {
    for (const action of [{ type: 'finish', success: true, summary: 'done' }, { type: 'wait', ms: 10 }] as ComputerAction[]) {
      const verdict = evaluate({ ...base, action, permissions: {} });
      assert.equal(verdict.decision, 'allow', `${action.type} needs no grant`);
    }
  });
});

describe('Action descriptions', () => {
  it('says what will happen concretely, never vaguely', () => {
    const description = describeAction({ type: 'click', to: { x: 640, y: 320 } });
    assert.match(description, /640/);
    assert.match(description, /320/);
    // A user cannot consent to "the agent wants to continue".
    for (const type of ACTION_TYPES) {
      assert.doesNotMatch(describeAction({ type, to: { x: 1, y: 1 }, text: 'x', key: 'a', keys: ['a'], ms: 1, name: 'x', summary: 'x', direction: 'down', from: { x: 0, y: 0 }, success: true } as never), /wants to|continue\?/i);
    }
  });
});

describe('Grounding', () => {
  it('scales a normalized point onto the real screen', () => {
    const screen = { width: 1280, height: 800, groundingWidth: 1000, groundingHeight: 1000, displays: 1, singleDisplayOnly: true };
    assert.deepEqual(toScreenPoint({ x: 500, y: 400 }, screen), { x: 640, y: 320 });
    assert.deepEqual(toScreenPoint({ x: 0, y: 0 }, screen), { x: 0, y: 0 });
  });

  it('is the identity when the model points in real pixels', () => {
    const screen = { width: 1280, height: 800, groundingWidth: 1280, groundingHeight: 800, displays: 1, singleDisplayOnly: true };
    assert.deepEqual(toScreenPoint({ x: 640, y: 320 }, screen), { x: 640, y: 320 });
  });

  it('clamps to the screen rather than pointing off it', () => {
    const screen = { width: 1280, height: 800, groundingWidth: 1000, groundingHeight: 1000, displays: 1, singleDisplayOnly: true };
    const point = toScreenPoint({ x: 5000, y: -20 }, screen);
    assert.equal(point.x, 1279);
    assert.equal(point.y, 0);
  });
});

describe('Plan parsing', () => {
  it('reads a plain JSON reply', () => {
    const parsed = parsePlan('{"summary":"Clicking the button","action":{"type":"click","to":{"x":10,"y":20}}}');
    assert.ok(!('error' in parsed));
    assert.equal(parsed.action.type, 'click');
    assert.equal(parsed.summary, 'Clicking the button');
  });

  it('reads a fenced reply, because models add fences unbidden', () => {
    const parsed = parsePlan('Sure!\n```json\n{"summary":"s","action":{"type":"screenshot"}}\n```\n');
    assert.ok(!('error' in parsed));
    assert.equal(parsed.action.type, 'screenshot');
  });

  it('accepts a bare action, rather than wasting a step on a formatting slip', () => {
    const parsed = parsePlan('{"type":"move","to":{"x":1,"y":2}}');
    assert.ok(!('error' in parsed));
    assert.equal(parsed.action.type, 'move');
  });

  it('reports an invalid action instead of passing it on', () => {
    const parsed = parsePlan('{"action":{"type":"exec","cmd":"rm -rf /"}}');
    assert.ok('error' in parsed);
  });

  it('reports a reply with no action at all', () => {
    assert.ok('error' in parsePlan('I am not sure what to do here.'));
  });
});

describe('Computer routing', () => {
  const model = (id: string, capabilities: string[], local = true): ModelDescriptor =>
    ({
      id,
      providerId: 'p',
      providerModelId: id,
      displayName: id,
      capabilities,
      modalities: ['text'],
      pricing: { kind: 'FREE' },
      contextLength: 8192,
    }) as unknown as ModelDescriptor;

  const backends = [
    {
      id: 'browser',
      name: 'Browser',
      description: '',
      surface: 'browser' as const,
      supportedActions: [],
      health: { available: true, detail: null, remediation: null, version: null },
      screen: null,
      needsGrounding: false,
    },
  ];

  it('refuses a model with no vision', () => {
    const { ok, missing } = canDriveComputer(model('chat', ['text']));
    assert.equal(ok, false);
    assert.ok(missing.includes('vision'));
  });

  it('accepts a model with vision', () => {
    assert.equal(canDriveComputer(model('vlm', ['text', 'vision'])).ok, true);
  });

  it('explains its choice rather than only naming it', () => {
    const decision = route({
      candidates: [{ model: model('vlm', ['text', 'vision']), available: true, local: true, latencyMs: 10, costPerMTok: 0 }],
      backends,
      privacyPreference: 'balanced',
      requestedModelId: null,
      requestedBackendId: null,
      groundingMode: 'auto',
      costSensitive: true,
    });
    assert.equal(decision.modelId, 'vlm');
    assert.ok(decision.factors.length > 0, 'the decision carries its reasoning');
  });

  it('says why a pinned model was refused', () => {
    const decision = route({
      candidates: [{ model: model('chat', ['text']), available: true, local: true, latencyMs: 10, costPerMTok: 0 }],
      backends,
      privacyPreference: 'balanced',
      requestedModelId: 'chat',
      requestedBackendId: null,
      groundingMode: 'auto',
      costSensitive: true,
    });
    assert.equal(decision.modelId, null);
    assert.match(decision.error ?? '', /vision/i);
  });

  it('never silently sends a screenshot to a hosted model under local_only', () => {
    const decision = route({
      candidates: [{ model: model('cloud-vlm', ['text', 'vision']), available: true, local: false, latencyMs: 10, costPerMTok: 3 }],
      backends,
      privacyPreference: 'local_only',
      requestedModelId: null,
      requestedBackendId: null,
      groundingMode: 'auto',
      costSensitive: true,
    });
    assert.equal(decision.modelId, null, 'no local model means no session, not a quiet fallback');
    assert.ok(decision.error, 'and it says so');
  });

  it('does not simply take the first model in the list', () => {
    // The first candidate is available but has no vision; Auto must skip it
    // rather than pick it and fail later.
    const decision = route({
      candidates: [
        { model: model('first-no-vision', ['text']), available: true, local: true, latencyMs: 1, costPerMTok: 0 },
        { model: model('second-vision', ['text', 'vision']), available: true, local: true, latencyMs: 50, costPerMTok: 0 },
      ],
      backends,
      privacyPreference: 'balanced',
      requestedModelId: null,
      requestedBackendId: null,
      groundingMode: 'auto',
      costSensitive: true,
    });
    assert.equal(decision.modelId, 'second-vision');
  });
});

describe('Permission presets', () => {
  it('read-only means look and nothing else', () => {
    assert.deepEqual(READ_ONLY_PERMISSIONS, { screen: true });
  });

  it('safe stops short of the filesystem, a shell, the network and other machines', () => {
    for (const denied of [
      'terminal',
      'files_read',
      'files_write',
      'files_delete',
      'files_download',
      'files_upload',
      'network',
      'docker',
      'mcp',
      'remote_computer',
    ] as const) {
      assert.notEqual(SAFE_PERMISSIONS[denied], true, `safe must not grant ${denied}`);
    }
  });

  it('grants nothing by default', () => {
    const verdict = evaluate({ action: { type: 'screenshot' }, permissions: {}, approvalMode: 'autonomous' });
    assert.equal(verdict.decision, 'reject', 'an empty permission set permits nothing, not everything');
  });
});
