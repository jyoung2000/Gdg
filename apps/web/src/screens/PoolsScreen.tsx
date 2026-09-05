import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  KeyValue,
  ModelPicker,
  PoolCard,
  Select,
  Stack,
  StatusChip,
  Table,
  IconLayers,
  IconPlus,
  type TableColumn,
} from '@meridian/ui';
import { formatCost, type PoolMember, type Reservation, type RoutingMode } from '@meridian/shared';
import { api, type PoolView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Inference pools and reservations.
 *
 * A pool is a routing policy, not a bag of models: its strategy overrides the
 * caller's mode, its budget is a hard ceiling, and its fallback chain decides
 * where traffic spills when it is saturated.
 */
export function PoolsScreen(): React.JSX.Element {
  const pools = useStore((s) => s.pools);
  const models = useStore((s) => s.models);
  const refreshPools = useStore((s) => s.refreshPools);
  const refreshModels = useStore((s) => s.refreshModels);
  const toast = useStore((s) => s.toast);

  const [editing, setEditing] = useState<PoolView | null>(null);
  const [reserving, setReserving] = useState<PoolView | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);

  useEffect(() => {
    void refreshPools();
    void refreshModels();
    void api.pools().then((r) => setReservations(r.reservations));
  }, [refreshModels, refreshPools]);

  const reservationColumns: TableColumn<Reservation>[] = [
    { key: 'label', header: 'Reservation', render: (r) => r.label },
    { key: 'pool', header: 'Pool', width: '120px', render: (r) => r.poolId },
    {
      key: 'status',
      header: 'Status',
      width: '110px',
      render: (r) => (
        <StatusChip status={r.status === 'active' ? 'busy' : r.status === 'scheduled' ? 'ready' : 'offline'} label={r.status} size="sm" />
      ),
    },
    { key: 'window', header: 'Window', width: '200px', render: (r) => `${new Date(r.startAt).toLocaleString()} → ${new Date(r.endAt).toLocaleTimeString()}` },
    { key: 'concurrency', header: 'Concurrency', width: '110px', align: 'end', render: (r) => <span className="mrd-numeric">{r.maxConcurrency}</span> },
    { key: 'budget', header: 'Budget', width: '100px', align: 'end', render: (r) => <span className="mrd-numeric">{r.budget == null ? 'unlimited' : formatCost(r.budget)}</span> },
    { key: 'spend', header: 'Spent', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{formatCost(r.spend)}</span> },
    {
      key: 'actions',
      header: '',
      width: '90px',
      align: 'end',
      render: (r) => (
        <Button
          size="sm"
          variant="tertiary"
          onClick={async () => {
            await api.deleteReservation(r.id);
            const next = await api.pools();
            setReservations(next.reservations);
            toast({ level: 'info', message: 'Reservation cancelled' });
          }}
        >
          Cancel
        </Button>
      ),
    },
  ];

  return (
    <Screen
      title="Inference pools"
      subtitle="Each pool is a routing policy with its own members, priority, concurrency and budget."
      actions={
        <Button
          variant="primary"
          icon={<IconPlus />}
          onClick={async () => {
            const { pool } = await api.createPool({ name: 'New pool', strategy: 'BALANCED' });
            await refreshPools();
            const created = (await api.pools()).pools.find((p) => p.id === pool.id) ?? null;
            setEditing(created);
          }}
        >
          New pool
        </Button>
      }
    >
      {pools.length === 0 ? (
        <EmptyState icon={<IconLayers />} title="No pools" description="Built-in pools are created on first start." />
      ) : (
        <div className="app__grid">
          {pools.map((p) => (
            <PoolCard
              key={p.id}
              pool={p}
              usage={p.usage}
              concurrencyLimit={p.concurrencyLimit}
              budgetLimit={p.budgetLimit}
              activeReservation={p.activeReservation}
              onEdit={() => setEditing(p)}
              onReserve={() => setReserving(p)}
            />
          ))}
        </div>
      )}

      <section>
        <h2 className="mrd-panel-title">Reservations</h2>
        <p className="mrd-caption" style={{ marginBottom: 'var(--space-3)' }}>
          A reservation grants a pool extra concurrency and its own budget for a fixed window. Outside the window it has no
          effect. Capacity is only ever described as unlimited when the pool genuinely has no ceiling.
        </p>
        <Table columns={reservationColumns} rows={reservations} rowKey={(r) => r.id} empty="No reservations." />
      </section>

      {editing && (
        <PoolEditor
          pool={editing}
          models={models}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refreshPools();
            setEditing(null);
          }}
        />
      )}

      {reserving && (
        <ReserveDialog
          pool={reserving}
          onClose={() => setReserving(null)}
          onCreated={async () => {
            const next = await api.pools();
            setReservations(next.reservations);
            await refreshPools();
            setReserving(null);
          }}
        />
      )}
    </Screen>
  );
}

function PoolEditor({
  pool,
  models,
  onClose,
  onSaved,
}: {
  pool: PoolView;
  models: { id: string; displayName: string; providerId: string; free: boolean }[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(pool.name);
  const [description, setDescription] = useState(pool.description ?? '');
  const [strategy, setStrategy] = useState<RoutingMode>(pool.strategy);
  const [members, setMembers] = useState<PoolMember[]>(pool.members);
  const [fallbackPoolId, setFallbackPoolId] = useState(pool.fallbackPoolId ?? '');
  const [maxConcurrency, setMaxConcurrency] = useState(String(pool.maxConcurrency ?? ''));
  const [dailyBudget, setDailyBudget] = useState(pool.dailyBudget == null ? '' : String(pool.dailyBudget));
  const pools = useStore((s) => s.pools);
  const toast = useStore((s) => s.toast);

  const addMember = (modelId: string): void => {
    if (members.some((m) => m.modelId === modelId)) return;
    setMembers([...members, { modelId, priority: 100 - members.length * 5, enabled: true }]);
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={`Edit ${pool.name}`} size="lg">
      <Stack direction="column" gap={5}>
        <Stack direction="column" gap={3}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={pool.builtin} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          </Field>
          <Field label="Strategy" description="The policy this pool applies. It overrides the caller's routing mode.">
            <Select value={strategy} onChange={(e) => setStrategy(e.currentTarget.value as RoutingMode)}>
              {['AUTO', 'BALANCED', 'QUALITY_FIRST', 'FASTEST', 'CHEAP_FIRST', 'FREE_FIRST', 'LOCAL_FIRST', 'FREE', 'LOCAL'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </Stack>

        <section>
          <h3 className="mrd-panel-title">Members and priority</h3>
          <p className="mrd-caption">
            An empty member list means the pool's strategy chooses from every eligible model, rather than the pool being a
            dead end.
          </p>
          <Stack direction="column" gap={2} style={{ marginTop: 'var(--space-2)' }}>
            {members.map((m, i) => (
              <Stack key={m.modelId} direction="row" gap={2} align="center">
                <span className="mrd-body mrd-truncate">{m.modelId}</span>
                <div className="mrd-spacer" />
                <Input
                  type="number"
                  value={String(m.priority)}
                  aria-label={`Priority for ${m.modelId}`}
                  size="sm"
                  style={{ width: 88 }}
                  onChange={(e) => {
                    const next = [...members];
                    next[i] = { ...m, priority: Number(e.currentTarget.value) };
                    setMembers(next);
                  }}
                />
                <Button size="sm" variant="tertiary" onClick={() => setMembers(members.filter((x) => x.modelId !== m.modelId))}>
                  Remove
                </Button>
              </Stack>
            ))}
            <ModelPicker models={models} onSelect={(id) => addMember(id)} placeholder="Add a model to this pool" />
          </Stack>
        </section>

        <section>
          <h3 className="mrd-panel-title">Limits</h3>
          <Stack direction="column" gap={3}>
            <Field label="Fallback pool" description="Where traffic spills when every member is unavailable.">
              <Select value={fallbackPoolId} onChange={(e) => setFallbackPoolId(e.currentTarget.value)}>
                <option value="">None</option>
                {pools
                  .filter((p) => p.id !== pool.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Max concurrency" description="Leave empty for no ceiling.">
              <Input type="number" value={maxConcurrency} onChange={(e) => setMaxConcurrency(e.currentTarget.value)} />
            </Field>
            <Field
              label="Daily budget, USD"
              description="0 makes this a no-spend pool: any call that would cost money is refused. Empty means no ceiling."
            >
              <Input type="number" step="0.01" value={dailyBudget} onChange={(e) => setDailyBudget(e.currentTarget.value)} />
            </Field>
          </Stack>
        </section>

        <Stack direction="row" gap={2} justify="end">
          {!pool.builtin && (
            <Button
              variant="destructive"
              onClick={async () => {
                await api.deletePool(pool.id);
                await onSaved();
              }}
            >
              Delete pool
            </Button>
          )}
          <div className="mrd-spacer" />
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await api.updatePool(pool.id, {
                name,
                description: description || null,
                strategy,
                members,
                fallbackPoolId: fallbackPoolId || null,
                maxConcurrency: maxConcurrency ? Number(maxConcurrency) : null,
                dailyBudget: dailyBudget === '' ? null : Number(dailyBudget),
              });
              toast({ level: 'success', message: `${name} saved` });
              await onSaved();
            }}
          >
            Save pool
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

function ReserveDialog({ pool, onClose, onCreated }: { pool: PoolView; onClose: () => void; onCreated: () => void | Promise<void> }): React.JSX.Element {
  const [hours, setHours] = useState('2');
  const [maxConcurrency, setMaxConcurrency] = useState('8');
  const [budget, setBudget] = useState('');
  const [label, setLabel] = useState(`${pool.name} window`);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={`Reserve capacity in ${pool.name}`} size="md">
      <Stack direction="column" gap={4}>
        <p className="mrd-secondary">
          During the window this pool runs at the reservation's concurrency and budget instead of its own. Outside it,
          nothing changes.
        </p>
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        </Field>
        <Field label="Duration, hours">
          <Select value={hours} onChange={(e) => setHours(e.currentTarget.value)}>
            <option value="2">2 hours</option>
            <option value="4">4 hours</option>
            <option value="8">8 hours</option>
            <option value="24">24 hours</option>
          </Select>
        </Field>
        <Field label="Max concurrency">
          <Input type="number" value={maxConcurrency} onChange={(e) => setMaxConcurrency(e.currentTarget.value)} />
        </Field>
        <Field label="Budget, USD" description="Leave empty to inherit the pool's ceiling.">
          <Input type="number" step="0.01" value={budget} onChange={(e) => setBudget(e.currentTarget.value)} />
        </Field>
        <Stack direction="row" gap={2} justify="end">
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await api.createReservation({
                poolId: pool.id,
                hours: Number(hours),
                label,
                maxConcurrency: Number(maxConcurrency),
                budget: budget === '' ? null : Number(budget),
              });
              await onCreated();
            }}
          >
            Reserve
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}
