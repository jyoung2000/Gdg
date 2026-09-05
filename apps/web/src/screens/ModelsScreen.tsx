import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ModelCard,
  SearchField,
  SegmentedControl,
  Stack,
  StatusChip,
  Table,
  TextArea,
  IconCpu,
  IconSplit,
  type TableColumn,
} from '@meridian/ui';
import { formatCost } from '@meridian/shared';
import { api, type ModelView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

type Layout = 'cards' | 'table';

/**
 * Browse, benchmark and compare models.
 *
 * The important honesty here is negative space: a model that has never been
 * measured shows "Not measured" rather than a zero or an invented score, so a
 * user cannot mistake absence of evidence for evidence of poor quality.
 */
export function ModelsScreen(): React.JSX.Element {
  const models = useStore((s) => s.models);
  const refreshModels = useStore((s) => s.refreshModels);
  const toast = useStore((s) => s.toast);

  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [layout, setLayout] = useState<Layout>('cards');
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [benchmarking, setBenchmarking] = useState<string | null>(null);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (freeOnly && !m.free) return false;
      if (!q) return true;
      return `${m.id} ${m.displayName} ${m.tags.join(' ')}`.toLowerCase().includes(q);
    });
  }, [freeOnly, models, query]);

  const toggle = (id: string): void => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < 6 ? [...s, id] : s));
  };

  const runBenchmark = async (id: string): Promise<void> => {
    setBenchmarking(id);
    try {
      const res = await api.benchmark(id);
      await refreshModels();
      toast({
        level: 'success',
        message: `Benchmarked ${id}`,
        detail: res.summary ? `coding ${res.summary.coding ?? '—'} · reasoning ${res.summary.reasoning ?? '—'}` : undefined,
      });
    } catch (e) {
      toast({ level: 'error', message: 'Benchmark failed', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBenchmarking(null);
    }
  };

  const columns: TableColumn<ModelView>[] = [
    {
      key: 'select',
      header: '',
      width: '36px',
      render: (m) => (
        <Checkbox
          checked={selected.includes(m.id)}
          onChange={() => toggle(m.id)}
          aria-label={`Select ${m.displayName} for comparison`}
        />
      ),
    },
    { key: 'name', header: 'Model', sortable: true, render: (m) => <span className="mrd-truncate">{m.displayName}</span> },
    { key: 'provider', header: 'Provider', width: '130px', sortable: true, render: (m) => m.providerId },
    {
      key: 'pricing',
      header: 'Pricing',
      width: '130px',
      render: (m) => <StatusChip status={m.free ? 'ready' : 'unknown'} label={pricingLabel(m)} size="sm" />,
    },
    {
      key: 'context',
      header: 'Context',
      width: '90px',
      align: 'end',
      sortable: true,
      render: (m) => <span className="mrd-numeric">{m.contextLength ? formatContext(m.contextLength) : '—'}</span>,
    },
    {
      key: 'latency',
      header: 'Latency',
      width: '90px',
      align: 'end',
      sortable: true,
      render: (m) => (
        <span className="mrd-numeric">{m.performance?.latencyMs ? `${(m.performance.latencyMs / 1000).toFixed(1)}s` : '—'}</span>
      ),
    },
    {
      key: 'coding',
      header: 'Coding',
      width: '90px',
      align: 'end',
      sortable: true,
      render: (m) => <span className="mrd-numeric">{m.scores?.coding != null ? Math.round(m.scores.coding) : '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '110px',
      align: 'end',
      render: (m) => (
        <Button size="sm" variant="tertiary" loading={benchmarking === m.id} onClick={() => void runBenchmark(m.id)}>
          Benchmark
        </Button>
      ),
    },
  ];

  return (
    <Screen
      title="Models"
      subtitle={`${filtered.length} of ${models.length} models routable from this instance`}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconSplit />}
            disabled={selected.length < 2}
            onClick={() => setComparing(true)}
          >
            Compare{selected.length ? ` (${selected.length})` : ''}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              await api.discover();
              await refreshModels();
              toast({ level: 'success', message: 'Discovery finished' });
            }}
          >
            Discover
          </Button>
        </>
      }
    >
      <Stack direction="row" gap={3} align="center" wrap>
        <SearchField
          value={query}
          onValueChange={setQuery}
          onClear={() => setQuery('')}
          placeholder="Search models"
          aria-label="Search models"
          style={{ minWidth: 240, flex: '1 1 240px' }}
        />
        <Checkbox checked={freeOnly} onChange={(e) => setFreeOnly(e.currentTarget.checked)} label="Free only" />
        <div className="mrd-spacer" />
        <SegmentedControl
          size="sm"
          value={layout}
          onChange={(v) => setLayout(v as Layout)}
          options={[
            { value: 'cards', label: 'Cards' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </Stack>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<IconCpu />}
          title={models.length ? 'No models match' : 'No models yet'}
          description={
            models.length
              ? 'Try a broader search, or clear the free-only filter.'
              : 'Connect a provider or start a local model server, then run discovery.'
          }
        />
      ) : layout === 'table' ? (
        <Table columns={columns} rows={filtered} rowKey={(m) => m.id} />
      ) : (
        <div className="app__grid">
          {filtered.slice(0, 120).map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              scores={m.scores}
              performance={m.performance}
              selected={selected.includes(m.id)}
              onSelect={() => toggle(m.id)}
              onBenchmark={() => void runBenchmark(m.id)}
              benchmarking={benchmarking === m.id}
            />
          ))}
        </div>
      )}

      <CompareDialog open={comparing} models={selected} onClose={() => setComparing(false)} />
    </Screen>
  );
}

function CompareDialog({ open, models, onClose }: { open: boolean; models: string[]; onClose: () => void }): React.JSX.Element {
  const [prompt, setPrompt] = useState('Write a JavaScript function that debounces another function. Return only the code.');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.compare>>['results'] | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setResults(null);
    try {
      const res = await api.compare({ models, prompt });
      setResults(res.results);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Compare models" size="lg">
      <Stack direction="column" gap={4}>
        <p className="mrd-secondary">
          The same prompt runs against each selected model. A model that fails is reported as a result, not hidden — that is
          part of what a comparison is for.
        </p>
        <TextArea value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} rows={4} aria-label="Comparison prompt" />
        <Stack direction="row" gap={2} justify="end">
          <Button variant="tertiary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            Run comparison
          </Button>
        </Stack>

        {results && (
          <div className="compare">
            {results.map((r) => (
              <Card key={r.modelId}>
                <Stack direction="column" gap={2}>
                  <Stack direction="row" gap={2} align="center">
                    <span className="mrd-section-title mrd-truncate">{r.modelId}</span>
                    <div className="mrd-spacer" />
                    <StatusChip status={r.error ? 'degraded' : 'ready'} label={r.error ? 'failed' : 'ok'} size="sm" />
                  </Stack>
                  <Stack direction="row" gap={3}>
                    <span className="mrd-caption mrd-numeric">{(r.latencyMs / 1000).toFixed(2)}s</span>
                    <span className="mrd-caption mrd-numeric">{formatCost(r.cost)}</span>
                    {r.toolCalls ? <span className="mrd-caption mrd-numeric">{r.toolCalls} tool calls</span> : null}
                  </Stack>
                  <pre className="compare__output mrd-code">{r.error ?? r.output ?? ''}</pre>
                </Stack>
              </Card>
            ))}
          </div>
        )}
      </Stack>
    </Dialog>
  );
}

function pricingLabel(m: ModelView): string {
  switch (m.pricing.kind) {
    case 'FREE':
      return 'Free';
    case 'FREE_DAILY':
      return 'Free (daily)';
    case 'FREE_MONTHLY':
      return 'Free (monthly)';
    case 'LOCAL':
      return 'Local';
    case 'TRIAL':
      return 'Trial credit';
    case 'CREDIT':
      return 'Promo credit';
    case 'UNKNOWN':
      return 'Unknown';
    default:
      return m.pricing.inputPerMTok != null ? `$${m.pricing.inputPerMTok}/M in` : 'Metered';
  }
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
