import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Panel,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconAlertTriangle,
  IconCheck,
  IconMonitor,
  IconPause,
  IconPlay,
  IconRefresh,
  IconStop,
  Select,
  Stack,
  StatusChip,
  TextArea,
} from '@meridian/ui';
import {
  api,
  type ComputerActionView,
  type ComputerBackendView,
  type ComputerCheckView,
  type ComputerPlanView,
  type ComputerSessionView,
  type ModelView,
} from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The computer agent.
 *
 * The screen is built around one idea: a user must never be unsure whether
 * something is driving their machine. So the running state is the loudest
 * thing on the page, Stop is always reachable while a session lives, and the
 * permissions a session was granted are shown beside what it is doing rather
 * than buried in the form that started it.
 *
 * Nothing here is on by default. The setup panel starts with no permissions
 * beyond the safe preset and an approval mode that asks, and the page says
 * plainly that computer control is off until a session is started.
 */

/** Permissions grouped the way a person thinks about them, not alphabetically. */
const PERMISSION_GROUPS: { title: string; note: string; items: { key: string; label: string; note: string }[] }[] = [
  {
    title: 'Look and point',
    note: 'The minimum an agent needs to see the screen and move around it.',
    items: [
      { key: 'screen', label: 'See the screen', note: 'Take screenshots and send them to the model.' },
      { key: 'mouse', label: 'Move and click', note: 'Move the pointer, click, and drag.' },
      { key: 'keyboard', label: 'Type', note: 'Send keystrokes, including shortcuts.' },
      { key: 'clipboard', label: 'Use the clipboard', note: 'Read and write the system clipboard.' },
    ],
  },
  {
    title: 'Applications',
    note: 'What the agent may launch or reach.',
    items: [
      { key: 'open_application', label: 'Open applications', note: 'Launch an application by name.' },
      { key: 'browser', label: 'Control a browser', note: 'Drive a browser session through Meridian.' },
      { key: 'terminal', label: 'Run terminal commands', note: 'Run shell commands on this machine.' },
      { key: 'docker', label: 'Use Docker', note: 'Start and stop containers.' },
      { key: 'network', label: 'Reach the network', note: 'Make outbound requests beyond the model call.' },
    ],
  },
  {
    title: 'Files',
    note: 'Granted separately for reading, changing and deleting, because they are not the same risk.',
    items: [
      { key: 'files_read', label: 'Read files', note: 'Open and read files.' },
      { key: 'files_write', label: 'Write files', note: 'Create and modify files.' },
      { key: 'files_delete', label: 'Delete files', note: 'Remove files permanently.' },
      { key: 'files_download', label: 'Download files', note: 'Save files from the network.' },
      { key: 'files_upload', label: 'Upload files', note: 'Send local files elsewhere.' },
    ],
  },
  {
    title: 'Extensions',
    note: 'Capabilities that reach beyond this machine.',
    items: [
      { key: 'mcp', label: 'Call MCP tools', note: 'Use the MCP servers assigned to this model.' },
      { key: 'remote_computer', label: 'Drive a remote computer', note: 'Act on a machine other than this one.' },
    ],
  },
];

const APPROVAL_LABELS: Record<string, { label: string; note: string }> = {
  every_action: { label: 'Ask before every action', note: 'Nothing happens without you saying yes. Slowest, safest.' },
  risky_actions: { label: 'Ask before risky actions', note: 'Routine steps run; anything elevated or destructive waits for you.' },
  autonomous: { label: 'Run without asking', note: 'Only destructive actions still stop for approval — that is not optional.' },
};

const LIVE_STATES = new Set(['starting', 'running', 'paused', 'awaiting_approval', 'stopping']);

function stateStatus(state: string): 'ready' | 'busy' | 'degraded' | 'offline' | 'error' | 'unknown' {
  if (state === 'running' || state === 'starting') return 'busy';
  if (state === 'awaiting_approval' || state === 'paused') return 'degraded';
  if (state === 'completed') return 'ready';
  if (state === 'failed') return 'error';
  if (state === 'stopped' || state === 'stopping') return 'offline';
  return 'unknown';
}

function riskVariant(risk: string): 'neutral' | 'warning' | 'error' {
  return risk === 'destructive' ? 'error' : risk === 'elevated' ? 'warning' : 'neutral';
}

function actionVariant(status: string): 'neutral' | 'accent' | 'success' | 'warning' | 'error' {
  if (status === 'completed') return 'success';
  if (status === 'denied') return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'executing') return 'accent';
  return 'neutral';
}

/** A short, literal sentence for an action — never "the agent wants to continue". */
function describe(action: Record<string, unknown> & { type: string }): string {
  const at = action.to as { x: number; y: number } | undefined;
  switch (action.type) {
    case 'screenshot':
      return 'Take a screenshot';
    case 'move':
      return at ? `Move the pointer to ${at.x}, ${at.y}` : 'Move the pointer';
    case 'click':
      return at ? `Click at ${at.x}, ${at.y}` : 'Click';
    case 'double_click':
      return at ? `Double-click at ${at.x}, ${at.y}` : 'Double-click';
    case 'right_click':
      return at ? `Right-click at ${at.x}, ${at.y}` : 'Right-click';
    case 'drag':
      return 'Drag across the screen';
    case 'type':
      return `Type ${String(action.text ?? '').length} character(s)`;
    case 'key_press':
      return `Press ${String(action.key ?? '')}`;
    case 'hotkey':
      return `Press ${(action.keys as string[] | undefined)?.join('+') ?? 'a shortcut'}`;
    case 'scroll':
      return `Scroll ${String(action.direction ?? '')}`;
    case 'wait':
      return `Wait ${Number(action.ms ?? 0)}ms`;
    case 'open_application':
      return `Open ${String(action.name ?? 'an application')}`;
    case 'close_application':
      return `Close ${String(action.name ?? 'an application')}`;
    case 'finish':
      return String(action.summary ?? 'Finish');
    default:
      return action.type;
  }
}

export function ComputerScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [backends, setBackends] = useState<ComputerBackendView[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [live, setLive] = useState<ComputerSessionView[]>([]);
  const [history, setHistory] = useState<ComputerSessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<ComputerSessionView | null>(null);
  const [actions, setActions] = useState<ComputerActionView[]>([]);
  const [shot, setShot] = useState<{ data: string; width: number; height: number } | null>(null);
  const [checks, setChecks] = useState<ComputerCheckView[] | null>(null);
  const [presets, setPresets] = useState<{ readOnly: Record<string, boolean>; safe: Record<string, boolean> } | null>(null);
  const [plan, setPlan] = useState<ComputerPlanView | null>(null);
  const [busy, setBusy] = useState(false);

  // Setup form. The defaults are the safe ones, deliberately.
  const [task, setTask] = useState('');
  const [backendId, setBackendId] = useState('auto');
  const [modelId, setModelId] = useState('auto');
  const [approvalMode, setApprovalMode] = useState('risky_actions');
  const [privacy, setPrivacy] = useState('balanced');
  const [maxSteps, setMaxSteps] = useState(20);
  // Empty until the gateway says what "safe" means, so the form can never show
  // a grant the backend would not actually apply.
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});

  const timelineRef = useRef<HTMLDivElement | null>(null);

  const refreshSessions = useCallback(async () => {
    const res = await api.computerSessions();
    setLive(res.live);
    setHistory(res.history);
    setActiveId((current) => current ?? res.live[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void api.computerBackends().then((r) => setBackends(r.backends)).catch(() => undefined);
    void api
      .computerVocabulary()
      .then((v) => {
        setPresets(v.presets);
        setPermissions(v.presets.safe);
      })
      .catch(() => undefined);
    void api.models().then((r) => setModels(r.models)).catch(() => undefined);
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  /* The live view polls while a session is alive, and stops when it is not. */
  const isLive = session ? LIVE_STATES.has(session.state) : false;
  useEffect(() => {
    if (!activeId) return undefined;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await api.computerSession(activeId);
        if (cancelled) return;
        setSession(res.session);
        setActions(res.actions);
        if (LIVE_STATES.has(res.session.state)) {
          const frame = await api.computerScreenshot(activeId).catch(() => null);
          if (!cancelled && frame) setShot(frame);
        }
      } catch {
        // A session that has been swept out of memory is read from history on
        // the next refresh; a transient read must not blank the view.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1200);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId, isLive]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [actions.length]);

  const visionModels = useMemo(
    () => models.filter((m) => m.capabilities?.includes('vision')),
    [models],
  );

  const previewPlan = useCallback(async () => {
    setBusy(true);
    try {
      const { decision } = await api.computerPlan({
        modelId: modelId === 'auto' ? null : modelId,
        backendId: backendId === 'auto' ? null : backendId,
        privacyPreference: privacy,
      });
      setPlan(decision);
      if (decision.error) toast({ level: 'warn', message: 'No usable configuration', detail: decision.error });
    } catch (e) {
      toast({ level: 'error', message: 'Could not work out a configuration', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [backendId, modelId, privacy, toast]);

  const runDiagnostics = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.computerDiagnostics(backendId === 'auto' ? undefined : backendId);
      setChecks(res.checks);
    } catch (e) {
      toast({ level: 'error', message: 'Diagnostics failed', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [backendId, toast]);

  const startSession = useCallback(async () => {
    if (!task.trim()) {
      toast({ level: 'warn', message: 'Describe what the agent should do first' });
      return;
    }
    setBusy(true);
    try {
      const { session: started } = await api.startComputerSession({
        task,
        modelId: modelId === 'auto' ? null : modelId,
        backendId: backendId === 'auto' ? null : backendId,
        permissions,
        approvalMode,
        privacyPreference: privacy,
        maxSteps,
      });
      setActiveId(started.id);
      setSession(started);
      setActions([]);
      setShot(null);
      await refreshSessions();
      toast({ level: 'info', message: 'The agent is now controlling this computer', detail: started.config.routingReason });
    } catch (e) {
      toast({ level: 'error', message: 'Could not start the session', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [approvalMode, backendId, maxSteps, modelId, permissions, privacy, refreshSessions, task, toast]);

  const control = useCallback(
    async (kind: 'pause' | 'resume' | 'stop') => {
      if (!activeId) return;
      try {
        if (kind === 'pause') await api.pauseComputerSession(activeId);
        else if (kind === 'resume') await api.resumeComputerSession(activeId);
        else {
          await api.stopComputerSession(activeId);
          toast({ level: 'info', message: 'The session was stopped' });
        }
        const res = await api.computerSession(activeId);
        setSession(res.session);
        setActions(res.actions);
        await refreshSessions();
      } catch (e) {
        toast({ level: 'error', message: `Could not ${kind} the session`, detail: (e as Error).message });
      }
    },
    [activeId, refreshSessions, toast],
  );

  const answer = useCallback(
    async (approvalId: string, decision: 'once' | 'task' | 'deny') => {
      if (!activeId) return;
      try {
        if (decision === 'deny') await api.denyComputerAction(activeId, approvalId);
        else await api.approveComputerAction(activeId, approvalId, decision);
        const res = await api.computerSession(activeId);
        setSession(res.session);
        setActions(res.actions);
      } catch (e) {
        toast({ level: 'error', message: 'Could not record your answer', detail: (e as Error).message });
      }
    },
    [activeId, toast],
  );

  const grantedCount = Object.values(permissions).filter(Boolean).length;
  const approval = session?.pendingApproval ?? null;
  const anyLive = live.some((s) => LIVE_STATES.has(s.state));

  return (
    <Screen
      title="Computer agent"
      subtitle="Let a model see this screen and operate it. Off unless you start a session."
      actions={
        <Stack direction="row" gap={2} align="center">
          <Button variant="tertiary" size="sm" icon={<IconRefresh />} onClick={() => void refreshSessions()}>
            Refresh
          </Button>
        </Stack>
      }
    >
      <Stack gap={4}>
        {/* The state of the machine, stated first and unmistakably. */}
        <Card>
          <Stack direction="row" gap={3} align="center" justify="between">
            <Stack direction="row" gap={3} align="center">
              <IconMonitor />
              <Stack gap={1}>
                <strong>{anyLive ? 'A model is controlling this computer right now' : 'Computer agent: off'}</strong>
                <span className="mrd-secondary">
                  {anyLive
                    ? `${live.filter((s) => LIVE_STATES.has(s.state)).length} live session(s). Stop ends control immediately.`
                    : 'Nothing is watching or driving this machine. Starting a session below is what turns it on.'}
                </span>
              </Stack>
            </Stack>
            {anyLive ? (
              <Button
                variant="destructive"
                icon={<IconStop />}
                onClick={() => {
                  for (const s of live.filter((x) => LIVE_STATES.has(x.state))) void api.stopComputerSession(s.id);
                  void refreshSessions();
                  toast({ level: 'info', message: 'Stopping every live session' });
                }}
              >
                Stop everything
              </Button>
            ) : (
              <StatusChip status="offline" label="Not running" />
            )}
          </Stack>
        </Card>

        {/* ---- What can actually run ------------------------------------ */}
        <Panel title="Backends" subtitle="Where the agent would act. Probed now, not assumed from configuration.">
          <Stack gap={2}>
            {backends.map((b) => (
              <Stack key={b.id} direction="row" gap={3} align="start" justify="between">
                <Stack gap={1}>
                  <Stack direction="row" gap={2} align="center">
                    <strong>{b.name}</strong>
                    <Badge variant="neutral" size="sm">
                      {b.surface}
                    </Badge>
                    {b.health.available ? (
                      <StatusChip status="ready" label={b.health.version ?? 'Ready'} size="sm" />
                    ) : (
                      <StatusChip status="offline" label="Unavailable" size="sm" />
                    )}
                  </Stack>
                  <span className="mrd-secondary">{b.description}</span>
                  {!b.health.available && b.health.detail ? <span className="mrd-caption">{b.health.detail}</span> : null}
                  {!b.health.available && b.health.remediation ? (
                    <span className="mrd-caption">To enable it: {b.health.remediation}</span>
                  ) : null}
                  {b.screen ? (
                    <span className="mrd-caption">
                      {b.screen.width}×{b.screen.height}, model coordinates in {b.screen.groundingWidth}×{b.screen.groundingHeight}
                      {b.screen.singleDisplayOnly ? ' · single display only' : ''}
                    </span>
                  ) : null}
                </Stack>
              </Stack>
            ))}
            {backends.length === 0 ? <span className="mrd-secondary">Loading backends…</span> : null}
          </Stack>
        </Panel>

        {/* ---- Setup ----------------------------------------------------- */}
        <Panel title="Start a session" subtitle="Nothing runs until you press Start. Review the permissions first.">
          <Stack gap={3}>
            <Field label="What should the agent do?" description="Be specific. The agent reads this and nothing else about your intent.">
              <TextArea
                rows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="e.g. Open the text editor and write today's date into a new note"
              />
            </Field>

            <Stack direction="row" gap={3} wrap>
              <Field label="Model" description="Auto picks by capability, not by a fixed model-to-agent pairing.">
                <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="auto">Auto</option>
                  {visionModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Backend" description="Any model can drive any backend it supports.">
                <Select value={backendId} onChange={(e) => setBackendId(e.target.value)}>
                  <option value="auto">Auto</option>
                  {backends.map((b) => (
                    <option key={b.id} value={b.id} disabled={!b.health.available}>
                      {b.name}
                      {b.health.available ? '' : ' — unavailable'}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Privacy" description="Local only never sends the screen to a hosted model.">
                <Select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
                  <option value="local_only">Local only</option>
                  <option value="balanced">Balanced</option>
                  <option value="any">Any model</option>
                </Select>
              </Field>
              <Field label="Step limit" description="A hard ceiling on how long the agent may keep going.">
                <Select value={String(maxSteps)} onChange={(e) => setMaxSteps(Number(e.target.value))}>
                  {[10, 20, 40, 80].map((n) => (
                    <option key={n} value={n}>
                      {n} steps
                    </option>
                  ))}
                </Select>
              </Field>
            </Stack>

            <Field label="Approvals" description="Destructive actions always ask, whatever you choose here.">
              <Select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value)}>
                {Object.entries(APPROVAL_LABELS).map(([value, { label }]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="mrd-caption">{APPROVAL_LABELS[approvalMode]?.note}</span>

            <Stack direction="row" gap={2} align="center">
              <Button variant="tertiary" size="sm" onClick={() => void previewPlan()} disabled={busy}>
                Preview what Auto would choose
              </Button>
              <Button variant="tertiary" size="sm" onClick={() => void runDiagnostics()} disabled={busy}>
                Run diagnostics
              </Button>
            </Stack>

            {plan ? (
              <Card>
                <Stack gap={1}>
                  <strong>{plan.error ? 'No usable configuration' : `${plan.modelId ?? 'no model'} on ${plan.backendId ?? 'no backend'}`}</strong>
                  <span className="mrd-secondary">{plan.error ?? plan.reason}</span>
                  {plan.factors.map((f) => (
                    <span key={f} className="mrd-caption">
                      · {f}
                    </span>
                  ))}
                  {plan.ineligible.slice(0, 4).map((i) => (
                    <span key={i.modelId} className="mrd-caption">
                      {i.modelId}: {i.reason}
                    </span>
                  ))}
                </Stack>
              </Card>
            ) : null}

            {checks ? (
              <Card>
                <Stack gap={1}>
                  {checks.map((c) => (
                    <Stack key={c.name} direction="row" gap={2} align="center">
                      {c.status === 'pass' ? <IconCheck /> : <IconAlertTriangle />}
                      <span>
                        <strong>{c.name}</strong> — {c.detail}
                      </span>
                    </Stack>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        </Panel>

        {/* ---- Permissions ---------------------------------------------- */}
        <Panel
          title={`Permissions (${grantedCount} granted)`}
          subtitle="Meridian enforces these itself. An action outside them is refused before it reaches this machine, whatever the model asks for."
        >
          <Stack gap={3}>
            {PERMISSION_GROUPS.map((group) => (
              <Stack key={group.title} gap={2}>
                <Stack gap={1}>
                  <strong>{group.title}</strong>
                  <span className="mrd-caption">{group.note}</span>
                </Stack>
                {group.items.map((item) => (
                  <Checkbox
                    key={item.key}
                    checked={permissions[item.key] === true}
                    label={item.label}
                    description={item.note}
                    onChange={(e) => setPermissions((p) => ({ ...p, [item.key]: e.target.checked }))}
                  />
                ))}
              </Stack>
            ))}
            <Stack direction="row" gap={2}>
              <Button variant="tertiary" size="sm" disabled={!presets} onClick={() => setPermissions(presets?.safe ?? {})}>
                Safe preset
              </Button>
              <Button variant="tertiary" size="sm" disabled={!presets} onClick={() => setPermissions(presets?.readOnly ?? {})}>
                Look only
              </Button>
              <Button variant="tertiary" size="sm" onClick={() => setPermissions({})}>
                Clear all
              </Button>
            </Stack>
          </Stack>
        </Panel>

        <Stack direction="row" gap={2}>
          <Button variant="primary" icon={<IconPlay />} onClick={() => void startSession()} disabled={busy || !task.trim()}>
            Start and hand over control
          </Button>
        </Stack>

        {/* ---- The live session ------------------------------------------ */}
        {session ? (
          <Panel
            title="Session"
            subtitle={session.config.task}
            actions={
              <Stack direction="row" gap={2}>
                {session.state === 'paused' ? (
                  <Button size="sm" variant="secondary" icon={<IconPlay />} onClick={() => void control('resume')}>
                    Resume
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconPause />}
                    disabled={!LIVE_STATES.has(session.state)}
                    onClick={() => void control('pause')}
                  >
                    Pause
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  icon={<IconStop />}
                  disabled={!LIVE_STATES.has(session.state)}
                  onClick={() => void control('stop')}
                >
                  Stop
                </Button>
              </Stack>
            }
          >
            <Stack gap={3}>
              <Stack direction="row" gap={3} align="center" wrap>
                <StatusChip status={stateStatus(session.state)} label={session.state.replace('_', ' ')} />
                <span className="mrd-caption">
                  Step {session.step} of {session.config.maxSteps}
                </span>
                <span className="mrd-caption">{session.activeModelId ?? 'no model'}</span>
                <span className="mrd-caption">{session.activeBackendId}</span>
                {Object.entries(session.config.permissions)
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <Badge key={k} variant="neutral" size="sm">
                      {k}
                    </Badge>
                  ))}
              </Stack>
              {session.config.routingReason ? <span className="mrd-caption">{session.config.routingReason}</span> : null}
              {session.summary ? <span className="mrd-secondary">{session.summary}</span> : null}

              {shot ? (
                <img
                  src={`data:image/png;base64,${shot.data}`}
                  alt={`The screen the agent is looking at, ${shot.width} by ${shot.height} pixels`}
                  style={{ width: '100%', border: '1px solid var(--mrd-border)', borderRadius: 'var(--mrd-radius-md)' }}
                />
              ) : null}

              <Stack gap={1}>
                <strong>What it has done</strong>
                <div ref={timelineRef} style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <Stack gap={2}>
                    {actions.map((a) => (
                      <Stack key={a.id} direction="row" gap={2} align="start">
                        <Badge variant={actionVariant(a.status)} size="sm">
                          {a.status}
                        </Badge>
                        <Stack gap={1}>
                          <span>
                            {a.step}. {describe(a.action)}
                          </span>
                          {a.verdict?.risk && a.verdict.risk !== 'safe' ? (
                            <Badge variant={riskVariant(a.verdict.risk)} size="sm">
                              {a.verdict.risk}
                            </Badge>
                          ) : null}
                          {a.result ? <span className="mrd-caption">{a.result}</span> : null}
                          {a.error ? <span className="mrd-caption">{a.error}</span> : null}
                        </Stack>
                      </Stack>
                    ))}
                    {actions.length === 0 ? <span className="mrd-secondary">Nothing yet.</span> : null}
                  </Stack>
                </div>
              </Stack>
            </Stack>
          </Panel>
        ) : null}

        {/* ---- History ---------------------------------------------------- */}
        <Panel title="Recent sessions" subtitle="Every run is recorded, including the actions that were refused.">
          {history.length === 0 && live.length === 0 ? (
            <EmptyState title="No sessions yet" description="Sessions you start will be listed here with what they did." />
          ) : (
            <Stack gap={2}>
              {[...live, ...history.filter((h) => !live.some((l) => l.id === h.id))].slice(0, 20).map((s) => (
                <Stack key={s.id} direction="row" gap={3} align="center" justify="between">
                  <Stack gap={1}>
                    <Stack direction="row" gap={2} align="center">
                      <StatusChip status={stateStatus(s.state)} label={s.state.replace('_', ' ')} size="sm" />
                      <span>{s.config?.task ?? '(no task recorded)'}</span>
                    </Stack>
                    {s.summary ? <span className="mrd-caption">{s.summary}</span> : null}
                  </Stack>
                  <Button size="sm" variant="tertiary" onClick={() => setActiveId(s.id)}>
                    Open
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
        </Panel>
      </Stack>

      {/* The approval gate. Not dismissible: it is a decision, and silence
          would otherwise read as consent. */}
      <Dialog
        open={approval !== null}
        onOpenChange={() => undefined}
        dismissible={false}
        title="The agent is asking permission"
        description={approval ? `Session ${approval.sessionId}` : ''}
        footer={
          approval ? (
            <Stack direction="row" gap={2} justify="end">
              <Button variant="destructive" onClick={() => void answer(approval.id, 'deny')}>
                Deny
              </Button>
              {approval.verdict.risk !== 'destructive' ? (
                <Button variant="secondary" onClick={() => void answer(approval.id, 'task')}>
                  Allow for this task
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => void answer(approval.id, 'once')}>
                Allow once
              </Button>
            </Stack>
          ) : null
        }
      >
        {approval ? (
          <Stack gap={2}>
            <strong>{approval.description}</strong>
            <Stack direction="row" gap={2} align="center">
              <Badge variant={riskVariant(approval.verdict.risk)}>{approval.verdict.risk}</Badge>
              {approval.verdict.requiredPermission ? (
                <Badge variant="neutral" size="sm">
                  needs {approval.verdict.requiredPermission}
                </Badge>
              ) : null}
            </Stack>
            {approval.verdict.reason ? <span className="mrd-secondary">{approval.verdict.reason}</span> : null}
            {approval.verdict.risk === 'destructive' ? (
              <span className="mrd-caption">
                Destructive actions can only be allowed one at a time — there is no way to approve them for the rest of the task.
              </span>
            ) : null}
            <span className="mrd-caption">Nothing has happened yet. This action runs only if you allow it.</span>
          </Stack>
        ) : null}
      </Dialog>
    </Screen>
  );
}
