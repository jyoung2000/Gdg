import { Badge, Card, EmptyState, KeyValue, Stack, StatusChip, IconRobot } from '@meridian/ui';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The agent roster.
 *
 * Each role has different economics, which is the whole reason there is more
 * than one: finding files should not consume a frontier model's budget, and
 * implementing a change should not be handed to the cheapest thing available.
 */
export function AgentsScreen(): React.JSX.Element {
  const vocabulary = useStore((s) => s.vocabulary);
  const pools = useStore((s) => s.pools);
  const agents = vocabulary?.agents ?? [];

  return (
    <Screen
      title="Agents"
      subtitle="Specialists with different jobs, routed to models that suit each one."
    >
      {agents.length === 0 ? (
        <EmptyState icon={<IconRobot />} title="No agents" description="The agent roster could not be loaded." />
      ) : (
        <div className="app__grid">
          {agents.map((a) => {
            const pool = pools.find((p) => p.id === a.pool);
            return (
              <Card key={a.role}>
                <Stack direction="column" gap={3}>
                  <Stack direction="row" gap={2} align="center">
                    <IconRobot />
                    <span className="mrd-section-title">{a.name}</span>
                    <div className="mrd-spacer" />
                    <StatusChip status="ready" label={a.preferredMode} size="sm" />
                  </Stack>
                  <p className="mrd-secondary">{a.description}</p>
                  <KeyValue
                    items={[
                      { label: 'Task type', value: a.taskType },
                      { label: 'Pool', value: pool ? `${pool.name} (${pool.strategy})` : a.pool },
                      { label: 'Max steps', value: String(a.maxSteps) },
                    ]}
                  />
                  <Stack direction="row" gap={1} wrap>
                    {a.tools.map((t) => (
                      <Badge key={t} variant="neutral">
                        {t}
                      </Badge>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </div>
      )}
    </Screen>
  );
}
