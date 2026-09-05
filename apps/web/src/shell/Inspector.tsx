import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Composer,
  EmptyState,
  FallbackNotice,
  KeyValue,
  Panel,
  RoutingExplanation,
  Stack,
  StatusChip,
  Timeline,
  TimelineStep,
  ToolCallCard,
  IconRobot,
  IconSparkle,
} from '@meridian/ui';
import { formatCost, formatDuration, type RoutingReason } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

/**
 * The assistant panel.
 *
 * This is an agent control surface, not a chat box: it shows what the agent is
 * doing right now, which model and provider each step ran on, what it cost,
 * which files it touched, and why the router chose what it chose. A user should
 * be able to answer "what is it doing and what will it cost" without leaving
 * this column.
 */
export function Inspector(): React.JSX.Element {
  const activeTaskId = useStore((s) => s.activeTaskId);
  const tasks = useStore((s) => s.tasks);
  const steps = useStore((s) => s.steps);
  const liveText = useStore((s) => s.liveText);
  const cancelTask = useStore((s) => s.cancelTask);
  const runTask = useStore((s) => s.runTask);
  const composerValue = useStore((s) => s.composerValue);
  const setComposerValue = useStore((s) => s.setComposerValue);
  const routingMode = useStore((s) => s.routingMode);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  const task = tasks.find((t) => t.id === activeTaskId) ?? null;
  const taskSteps = activeTaskId ? (steps[activeTaskId] ?? []) : [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<Awaited<ReturnType<typeof api.task>>['toolCalls']>([]);
  const [routing, setRouting] = useState<RoutingReason | null>(null);

  // The step list arrives over the event stream, but tool-call detail is bulky
  // and only fetched when a step is actually expanded.
  useEffect(() => {
    if (!activeTaskId || !expanded) return;
    let cancelled = false;
    void api
      .task(activeTaskId)
      .then((d) => {
        if (!cancelled) setToolCalls(d.toolCalls.filter((c) => c.stepId === expanded || !c.stepId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTaskId, expanded]);

  // Explain what the router would pick right now for what is typed.
  useEffect(() => {
    if (!composerValue.trim() || task) {
      setRouting(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .routingPreview({ modality: 'text', taskType: 'coding', prompt: composerValue, mode: routingMode, workspaceId: activeWorkspaceId })
        .then((p) => setRouting(p.decision?.routingReason ?? null))
        .catch(() => setRouting(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [activeWorkspaceId, composerValue, routingMode, task]);

  const fallbacks = useMemo(() => taskSteps.flatMap((s) => s.fallbackEvents), [taskSteps]);

  return (
    <aside className="app__inspector" aria-label="Assistant">
      <div className="inspector__header">
        <IconRobot />
        <span className="mrd-section-title">Assistant</span>
        <div className="mrd-spacer" />
        {task && (task.status === 'running' || task.status === 'queued') && (
          <Button size="sm" variant="tertiary" onClick={() => void cancelTask(task.id)}>
            Stop
          </Button>
        )}
      </div>

      <div className="inspector__body">
        {!task && !routing && (
          <EmptyState
            icon={<IconSparkle />}
            title="Nothing running"
            description="Describe what you want built. Meridian picks the models, runs the agents, and shows you the diff before anything is kept."
          />
        )}

        {routing && !task && (
          <div className="inspector__section">
            <div className="mrd-panel-title">Would route to</div>
            <RoutingExplanation reason={routing} />
          </div>
        )}

        {task && (
          <>
            <div className="inspector__section">
              <div className="mrd-panel-title">Task</div>
              <div className="mrd-body">{task.title}</div>
              <Stack direction="row" gap={2} align="center" wrap>
                <StatusChip status={statusFor(task.status)} label={task.status} size="sm" />
                {task.estimate && (
                  <span className="mrd-caption mrd-numeric">
                    est. {formatCost(task.estimate.cost)} · {task.estimate.calls} calls
                  </span>
                )}
              </Stack>
            </div>

            <div className="inspector__section">
              <div className="mrd-panel-title">Progress</div>
              <Timeline>
                {taskSteps.map((step) => (
                  <TimelineStep
                    key={step.id}
                    status={step.status}
                    label={step.label}
                    meta={step.modelId ?? undefined}
                    duration={step.latencyMs ? formatDuration(step.latencyMs) : undefined}
                    expanded={expanded === step.id}
                    onExpandedChange={(open) => setExpanded(open ? step.id : null)}
                    details={
                      <>
                    <KeyValue
                      items={[
                        { label: 'Model', value: step.modelId ?? 'not yet chosen' },
                        { label: 'Provider', value: step.providerId ?? '—' },
                        { label: 'Latency', value: step.latencyMs ? formatDuration(step.latencyMs) : '—' },
                        { label: 'Tokens', value: step.usage ? String(step.usage.totalTokens) : '—' },
                        { label: 'Cost', value: step.usage ? formatCost(step.usage.cost) : '—' },
                        { label: 'Tool calls', value: String(step.toolCallCount) },
                        { label: 'Files', value: step.filesTouched.length ? step.filesTouched.join(', ') : '—' },
                      ]}
                    />
                    {step.summary && <p className="mrd-secondary">{step.summary}</p>}
                    {liveText[step.id] && step.status === 'running' && (
                      <p className="mrd-secondary">{liveText[step.id].slice(-600)}</p>
                    )}
                    {step.error && <p className="mrd-secondary">{step.error}</p>}
                    {toolCalls
                      .filter((c) => c.stepId === step.id)
                      .slice(0, 20)
                      .map((c) => (
                        <ToolCallCard
                          key={c.id}
                          name={c.name}
                          args={c.arguments}
                          result={c.result}
                          error={c.error}
                          durationMs={c.durationMs}
                        />
                      ))}
                      </>
                    }
                  />
                ))}
              </Timeline>
            </div>

            {fallbacks.length > 0 && (
              <div className="inspector__section">
                <div className="mrd-panel-title">Recovered</div>
                {fallbacks.map((f, i) => (
                  <FallbackNotice
                    key={`${f.at}-${i}`}
                    message={f.message}
                    provider={f.fromProvider}
                    reason={f.code}
                    fallbackModel={f.toModel}
                  />
                ))}
              </div>
            )}

            {task.result && (
              <div className="inspector__section">
                <div className="mrd-panel-title">Result</div>
                <p className="mrd-secondary" style={{ whiteSpace: 'pre-wrap' }}>
                  {task.result}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="inspector__footer">
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSubmit={() => void runTask(composerValue)}
          running={Boolean(task && (task.status === 'running' || task.status === 'queued'))}
          onStop={() => task && void cancelTask(task.id)}
          placeholder="Describe what you want to build…"
          disabled={!activeWorkspaceId}
        />
      </div>
    </aside>
  );
}

function statusFor(status: string): 'ready' | 'busy' | 'degraded' | 'offline' | 'unknown' {
  switch (status) {
    case 'completed':
      return 'ready';
    case 'running':
    case 'queued':
      return 'busy';
    case 'failed':
      return 'degraded';
    case 'cancelled':
      return 'offline';
    default:
      return 'unknown';
  }
}
