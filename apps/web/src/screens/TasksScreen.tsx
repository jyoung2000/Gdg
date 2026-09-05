import { useEffect, useState } from 'react';
import {
  Button,
  EmptyState,
  KeyValue,
  Card,
  Stack,
  StatusChip,
  TaskCard,
  Timeline,
  TimelineStep,
  IconActivity,
  IconSplit,
} from '@meridian/ui';
import { formatCost, formatDuration, formatRelative } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';
import { ParallelDialog } from './ParallelDialog.js';

/** Task history and the parallel-lane view. */
export function TasksScreen(): React.JSX.Element {
  const tasks = useStore((s) => s.tasks);
  const steps = useStore((s) => s.steps);
  const refreshTasks = useStore((s) => s.refreshTasks);
  const openTask = useStore((s) => s.openTask);
  const cancelTask = useStore((s) => s.cancelTask);
  const activeTaskId = useStore((s) => s.activeTaskId);
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const toast = useStore((s) => s.toast);
  const [parallelOpen, setParallelOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const active = tasks.find((t) => t.id === activeTaskId) ?? null;
  const activeSteps = activeTaskId ? (steps[activeTaskId] ?? []) : [];
  const lanes = tasks.filter((t) => t.lane && (t.running || t.status === 'running' || t.status === 'completed')).slice(0, 8);

  return (
    <Screen
      title="Tasks"
      subtitle="Everything the agents have run, with the models, cost and outcome of each step."
      actions={
        <Button variant="secondary" icon={<IconSplit />} disabled={!workspaceId} onClick={() => setParallelOpen(true)}>
          Run parallel agents
        </Button>
      }
    >
      {lanes.length > 0 && (
        <section>
          <h2 className="mrd-panel-title">Lanes</h2>
          <div className="app__grid">
            {lanes.map((t) => (
              <TaskCard
                key={t.id}
                lane={t.lane ?? 'main'}
                title={t.title}
                status={t.status}
                elapsedMs={(t.finishedAt ?? Date.now()) - (t.startedAt ?? t.createdAt)}
                model={steps[t.id]?.find((s) => s.status === 'running')?.modelId ?? null}
                currentStep={steps[t.id]?.find((s) => s.status === 'running')?.label ?? null}
                onCancel={t.running ? () => void cancelTask(t.id) : undefined}
                onOpen={() => void openTask(t.id)}
              />
            ))}
          </div>
        </section>
      )}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<IconActivity />}
          title="No tasks yet"
          description="Describe what you want in the assistant panel. Meridian plans the steps, picks a model for each, and shows you the diff before anything is kept."
        />
      ) : (
        <section>
          <h2 className="mrd-panel-title">History</h2>
          <Stack direction="column" gap={2}>
            {tasks.map((t) => (
              <Card key={t.id}>
                <Stack direction="column" gap={3}>
                  <Stack direction="row" gap={3} align="center">
                    <StatusChip
                      status={t.status === 'completed' ? 'ready' : t.status === 'running' ? 'busy' : t.status === 'failed' ? 'degraded' : 'unknown'}
                      label={t.status}
                      size="sm"
                    />
                    <span className="mrd-truncate">{t.title}</span>
                    <div className="mrd-spacer" />
                    <span className="mrd-caption mrd-numeric">{formatCost(t.usage.cost)}</span>
                    <span className="mrd-caption">{formatRelative(t.createdAt, Date.now())}</span>
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() => {
                        setExpanded(expanded === t.id ? null : t.id);
                        void openTask(t.id);
                      }}
                      aria-expanded={expanded === t.id}
                    >
                      {expanded === t.id ? 'Hide' : 'Details'}
                    </Button>
                  </Stack>
                {expanded === t.id && (
                  <Stack direction="column" gap={4}>
                    <KeyValue
                      items={[
                        { label: 'Request', value: t.request },
                        { label: 'Mode', value: t.mode },
                        { label: 'Tokens', value: String(t.usage.totalTokens) },
                        { label: 'Cost', value: formatCost(t.usage.cost) },
                        { label: 'Estimate', value: t.estimate ? `${formatCost(t.estimate.cost)} · ${t.estimate.calls} calls` : '—' },
                        { label: 'Duration', value: t.finishedAt && t.startedAt ? formatDuration(t.finishedAt - t.startedAt) : '—' },
                      ]}
                    />
                    <Timeline>
                      {(steps[t.id] ?? []).map((s) => (
                        <TimelineStep
                          key={s.id}
                          status={s.status}
                          label={s.label}
                          duration={s.latencyMs ? formatDuration(s.latencyMs) : undefined}
                        >
                          <KeyValue
                            items={[
                              { label: 'Model', value: s.modelId ?? '—' },
                              { label: 'Provider', value: s.providerId ?? '—' },
                              { label: 'Tool calls', value: String(s.toolCallCount) },
                              { label: 'Files', value: s.filesTouched.join(', ') || '—' },
                            ]}
                          />
                          {s.summary && <p className="mrd-secondary">{s.summary}</p>}
                        </TimelineStep>
                      ))}
                    </Timeline>
                    <Stack direction="row" gap={2}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          await api.taskFeedback(t.id, 'positive');
                          toast({ level: 'success', message: 'Thanks — that feeds into future model choices' });
                        }}
                      >
                        Good result
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          await api.taskFeedback(t.id, 'negative');
                          toast({ level: 'info', message: 'Noted — these models will rank lower for this kind of task' });
                        }}
                      >
                        Poor result
                      </Button>
                    </Stack>
                  </Stack>
                )}
                </Stack>
              </Card>
            ))}
          </Stack>
        </section>
      )}

      {parallelOpen && workspaceId && <ParallelDialog workspaceId={workspaceId} onClose={() => setParallelOpen(false)} />}
    </Screen>
  );
}
