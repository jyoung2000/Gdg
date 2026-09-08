import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  Field,
  SegmentedControl,
  Select,
  Stack,
  StatusChip,
  TextArea,
  IconSparkle,
} from '@meridian/ui';
import { formatCost, type RoutingMode, type TaskEstimate, type TaskStep } from '@meridian/shared';
import { api, type RoutingPreview } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The Director: the assistant as a first-class destination.
 *
 * Idea → plan → execute, in that order and with a stop between each. The
 * stops are the feature. Meridian plans with real machinery — the
 * orchestrator's own pipeline planner, the same router that will serve the
 * work — so the plan it shows is the plan it will run, priced and staffed,
 * and nothing executes until the person who typed the idea has seen both.
 *
 * "Best model for the situation" is not a slogan here; it is visible. Every
 * step in the plan names its agent, the kind of work it does, the routing
 * mode that suits that work, and the model the router would pick for it right
 * now. A planner routes for quality, a file-finder for speed, a browser agent
 * for cheapness — and when the plan runs, each step's card shows the model
 * that actually served it.
 */

type Phase = 'idea' | 'plan' | 'run';
type PipelineKind = 'auto' | 'code' | 'research' | 'debug' | 'tests';

interface PlanState {
  estimate: TaskEstimate;
  steps: string[];
  rationale: string;
  /** Router's live answer per role: which model would take this step now. */
  previews: Record<string, RoutingPreview | null>;
}

const PIPELINE_OPTIONS: { value: PipelineKind; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'code', label: 'Code' },
  { value: 'research', label: 'Research' },
  { value: 'debug', label: 'Debug' },
  { value: 'tests', label: 'Tests' },
];

/**
 * What a step costs, including when nobody knows.
 *
 * A null price means this provider publishes no rate for the model, so the
 * plan cannot say what the step will cost. Rendering that as "free" — which is
 * what `$0.00` reads as next to a step that says "free" — would be the one
 * mistake this screen must not make, since the whole point of the plan is that
 * the operator approves the spend before it happens.
 */
function describeStepCost(usd: number | null): string {
  if (usd == null) return 'price unknown';
  return usd === 0 ? 'free' : formatCost(usd);
}

export function DirectorScreen(): React.JSX.Element {
  const vocabulary = useStore((s) => s.vocabulary);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const routingMode = useStore((s) => s.routingMode);
  const runTask = useStore((s) => s.runTask);
  const tasks = useStore((s) => s.tasks);
  const steps = useStore((s) => s.steps);
  const openTask = useStore((s) => s.openTask);
  const setScreen = useStore((s) => s.setScreen);
  const toast = useStore((s) => s.toast);

  const [phase, setPhase] = useState<Phase>('idea');
  const [idea, setIdea] = useState('');
  const [pipelineKind, setPipelineKind] = useState<PipelineKind>('auto');
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [planning, setPlanning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);

  const agentsByRole = useMemo(() => {
    const map = new Map<string, NonNullable<typeof vocabulary>['agents'][number]>();
    for (const a of vocabulary?.agents ?? []) map.set(a.role, a);
    return map;
  }, [vocabulary]);

  const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
  const taskSteps: TaskStep[] = taskId ? (steps[taskId] ?? []) : [];

  // Keep the running task's steps flowing in even if events raced the mount.
  useEffect(() => {
    if (taskId) void openTask(taskId);
  }, [taskId, openTask]);

  const draftPlan = useCallback(
    async (kind: PipelineKind) => {
      if (!activeWorkspaceId) {
        toast({ level: 'warn', message: 'Open a workspace first', detail: 'The Director builds inside a workspace so the diff has somewhere to land.' });
        return;
      }
      if (!idea.trim()) return;
      setPlanning(true);
      try {
        const { estimate, pipeline } = await api.estimate({
          workspaceId: activeWorkspaceId,
          request: kind === 'auto' ? idea : `[pipeline:${kind}] ${idea}`,
          mode: routingMode,
        });

        // One routing preview per distinct role, asked with that role's own
        // task type and preferred mode — the same question the executor will
        // ask when the step actually runs.
        const uniqueRoles = [...new Set(pipeline.steps)];
        const previewEntries = await Promise.all(
          uniqueRoles.map(async (role) => {
            const agent = agentsByRole.get(role);
            const preview = await api
              .routingPreview({
                modality: 'text',
                taskType: agent?.taskType ?? 'chat',
                mode: (agent?.preferredMode as RoutingMode | undefined) ?? routingMode,
                prompt: idea,
                workspaceId: activeWorkspaceId,
              })
              .catch(() => null);
            return [role, preview] as const;
          }),
        );

        setPlan({
          estimate,
          steps: pipeline.steps,
          rationale: pipeline.rationale,
          previews: Object.fromEntries(previewEntries),
        });
        setPhase('plan');
      } catch (e) {
        toast({ level: 'error', message: 'Could not draft a plan', detail: (e as Error).message });
      } finally {
        setPlanning(false);
      }
    },
    [activeWorkspaceId, agentsByRole, idea, routingMode, toast],
  );

  const execute = async (): Promise<void> => {
    const id = await runTask(idea, pipelineKind === 'auto' ? {} : { pipeline: pipelineKind });
    if (id) {
      setTaskId(id);
      setPhase('run');
    }
  };

  const reset = (): void => {
    setPhase('idea');
    setPlan(null);
    setTaskId(null);
    setIdea('');
    setPipelineKind('auto');
  };

  return (
    <Screen
      title="Director"
      subtitle="Give it an idea. It plans with real agents, shows you the cost and the models, and executes only when you say so."
      actions={
        phase !== 'idea' ? (
          <Button variant="tertiary" onClick={reset}>
            New idea
          </Button>
        ) : undefined
      }
    >
      <Stack direction="column" gap={4}>
        {phase === 'idea' && (
          <IdeaPhase
            idea={idea}
            setIdea={setIdea}
            planning={planning}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onPickWorkspace={(id) => void openWorkspace(id)}
            onDraft={() => void draftPlan(pipelineKind)}
          />
        )}

        {phase === 'plan' && plan && (
          <PlanPhase
            idea={idea}
            plan={plan}
            planning={planning}
            pipelineKind={pipelineKind}
            onKindChange={(k) => {
              setPipelineKind(k);
              void draftPlan(k);
            }}
            agentsByRole={agentsByRole}
            onBack={() => setPhase('idea')}
            onExecute={() => void execute()}
          />
        )}

        {phase === 'run' && (
          <RunPhase
            taskTitle={task?.title ?? idea}
            status={task?.status ?? 'running'}
            error={task?.error ?? null}
            cost={task?.usage?.cost ?? 0}
            steps={taskSteps}
            agentsByRole={agentsByRole}
            onReviewChanges={() => setScreen('versioncontrol')}
          />
        )}
      </Stack>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 1 — the idea                                                  */
/* ------------------------------------------------------------------ */

function IdeaPhase({
  idea,
  setIdea,
  planning,
  workspaces,
  activeWorkspaceId,
  onPickWorkspace,
  onDraft,
}: {
  idea: string;
  setIdea: (v: string) => void;
  planning: boolean;
  workspaces: { id: string; name: string }[];
  activeWorkspaceId: string | null;
  onPickWorkspace: (id: string) => void;
  onDraft: () => void;
}): React.JSX.Element {
  return (
    <Card>
      <Stack direction="column" gap={3}>
        <Stack direction="row" gap={2} align="center">
          <IconSparkle />
          <strong>What should be built?</strong>
        </Stack>
        <TextArea
          rows={5}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Describe the idea in plain words — a feature, a fix, a script, a piece of research. The Director turns it into a staffed, priced plan before anything runs."
        />
        <Stack direction="row" gap={3} align="end" wrap>
          <Field label="Workspace" description="Where the work lands, so the diff is reviewable.">
            <Select value={activeWorkspaceId ?? ''} onChange={(e) => e.target.value && onPickWorkspace(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" onClick={onDraft} disabled={planning || !idea.trim() || !activeWorkspaceId}>
            {planning ? 'Planning…' : 'Draft the plan'}
          </Button>
        </Stack>
        <span className="mrd-caption mrd-secondary">
          Nothing executes at this stage. Drafting a plan reads the workspace and asks the router what it would
          do; it makes no changes and spends nothing.
        </span>
      </Stack>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 2 — the plan                                                  */
/* ------------------------------------------------------------------ */

function PlanPhase({
  idea,
  plan,
  planning,
  pipelineKind,
  onKindChange,
  agentsByRole,
  onBack,
  onExecute,
}: {
  idea: string;
  plan: PlanState;
  planning: boolean;
  pipelineKind: PipelineKind;
  onKindChange: (k: PipelineKind) => void;
  agentsByRole: Map<string, { role: string; name: string; description: string; taskType: string; preferredMode: string }>;
  onBack: () => void;
  onExecute: () => void;
}): React.JSX.Element {
  const e = plan.estimate;
  return (
    <Stack direction="column" gap={4}>
      <Card>
        <Stack direction="column" gap={2}>
          <span className="mrd-secondary mrd-truncate">“{idea}”</span>
          <Stack direction="row" gap={3} align="center" wrap>
            <Field label="Pipeline" description="Auto lets the orchestrator decide; the rest force a shape.">
              <SegmentedControl
                value={pipelineKind}
                onChange={(v) => onKindChange(v as PipelineKind)}
                options={PIPELINE_OPTIONS}
              />
            </Field>
            {planning && <span className="mrd-caption mrd-secondary">Re-planning…</span>}
          </Stack>
          <span className="mrd-secondary">{plan.rationale}</span>
        </Stack>
      </Card>

      <Stack direction="column" gap={3}>
        {plan.steps.map((role, i) => {
          const agent = agentsByRole.get(role);
          const preview = plan.previews[role];
          const candidate = preview?.decision ?? null;
          return (
            <Card key={`${role}-${i}`}>
              <Stack direction="row" gap={3} align="center" wrap>
                <span className="mrd-numeric mrd-secondary" style={{ minWidth: 24 }}>
                  {i + 1}
                </span>
                <Stack direction="column" gap={1} style={{ flex: 1, minWidth: 220 }}>
                  <strong>{agent?.name ?? role}</strong>
                  <span className="mrd-caption mrd-secondary">{agent?.description ?? ''}</span>
                </Stack>
                <Stack direction="column" gap={1} align="end">
                  <StatusChip
                    status={candidate ? 'ready' : 'unknown'}
                    size="sm"
                    label={candidate ? `${candidate.provider}:${candidate.model}` : 'No route yet'}
                  />
                  <span className="mrd-caption mrd-secondary mrd-numeric">
                    {agent?.taskType ?? 'chat'} · {agent?.preferredMode ?? '—'}
                    {candidate ? ` · ${describeStepCost(candidate.expectedCost)}` : ''}
                  </span>
                </Stack>
              </Stack>
            </Card>
          );
        })}
      </Stack>

      <Card>
        <Stack direction="row" gap={4} align="center" wrap>
          <Stat label="Model calls" value={String(e.calls)} />
          <Stat label="Models" value={String(e.models)} />
          <Stat label="Est. tokens" value={e.tokens.toLocaleString()} />
          <Stat label="Est. time" value={`~${e.seconds}s`} />
          <Stat
            label={e.costKnown ? 'Est. cost' : 'Est. cost (at least)'}
            value={e.costKnown && e.cost === 0 ? 'Free' : formatCost(e.cost)}
            strong
          />
          {e.freeAvailable && <StatusChip status="ready" size="sm" label="Free routes available" />}
          {!e.costKnown && (
            <StatusChip status="degraded" size="sm" label="A step has no published price" />
          )}
          <div className="mrd-spacer" />
          <Button variant="secondary" onClick={onBack}>
            Edit the idea
          </Button>
          <Button variant="primary" onClick={onExecute} disabled={planning}>
            Run this plan
          </Button>
        </Stack>
        {e.note && <span className="mrd-caption mrd-secondary">{e.note}</span>}
      </Card>
    </Stack>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <Stack direction="column" gap={1}>
      <span className="mrd-caption mrd-secondary">{label}</span>
      {strong ? <strong className="mrd-numeric">{value}</strong> : <span className="mrd-numeric">{value}</span>}
    </Stack>
  );
}

/* ------------------------------------------------------------------ */
/* Phase 3 — execution                                                 */
/* ------------------------------------------------------------------ */

function RunPhase({
  taskTitle,
  status,
  error,
  cost,
  steps,
  agentsByRole,
  onReviewChanges,
}: {
  taskTitle: string;
  status: string;
  error: string | null;
  cost: number;
  steps: TaskStep[];
  agentsByRole: Map<string, { role: string; name: string }>;
  onReviewChanges: () => void;
}): React.JSX.Element {
  const done = status === 'completed';
  const failed = status === 'failed';
  return (
    <Stack direction="column" gap={4}>
      <Card>
        <Stack direction="row" gap={3} align="center" wrap>
          <StatusChip
            status={done ? 'ready' : failed ? 'offline' : 'busy'}
            label={done ? 'Completed' : failed ? 'Failed' : 'Running'}
          />
          <strong className="mrd-truncate" style={{ flex: 1 }}>
            {taskTitle}
          </strong>
          <span className="mrd-caption mrd-numeric">{cost === 0 ? 'Free so far' : `${formatCost(cost)} so far`}</span>
          {done && (
            <Button variant="primary" onClick={onReviewChanges}>
              Review the changes
            </Button>
          )}
        </Stack>
        {error && <span className="mrd-caption mrd-warn">{error}</span>}
      </Card>

      {steps.length === 0 ? (
        <EmptyState title="Starting up" description="The first agent is being routed. Steps appear here as they begin." />
      ) : (
        <Stack direction="column" gap={3}>
          {steps.map((s) => (
            <Card key={s.id}>
              <Stack direction="row" gap={3} align="center" wrap>
                <StatusChip
                  status={
                    s.status === 'completed' ? 'ready' : s.status === 'failed' ? 'offline' : s.status === 'running' ? 'busy' : 'unknown'
                  }
                  size="sm"
                  label={s.status}
                />
                <Stack direction="column" gap={1} style={{ flex: 1, minWidth: 220 }}>
                  <strong>{agentsByRole.get(s.role)?.name ?? s.label}</strong>
                  {s.summary && <span className="mrd-caption mrd-secondary">{s.summary}</span>}
                  {s.filesTouched.length > 0 && (
                    <span className="mrd-caption mrd-secondary mrd-numeric">{s.filesTouched.join(', ')}</span>
                  )}
                </Stack>
                <Stack direction="column" gap={1} align="end">
                  {/* The promise made in the plan, kept in the run: the model
                      that actually served this step, not the one hoped for. */}
                  <span className="mrd-caption mrd-numeric">
                    {s.modelId ? `${s.providerId}:${s.modelId}` : '—'}
                  </span>
                  <span className="mrd-caption mrd-secondary mrd-numeric">
                    {s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)}s` : ''}
                    {s.usage ? ` · ${s.usage.cost === 0 ? 'free' : formatCost(s.usage.cost)}` : ''}
                  </span>
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
