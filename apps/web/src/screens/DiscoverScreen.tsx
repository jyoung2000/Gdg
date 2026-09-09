import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  SearchField,
  SegmentedControl,
  Stack,
  StatusChip,
  Table,
  type TableColumn,
} from '@meridian/ui';
import {
  api,
  type CatalogStatus,
  type DiscoveryStatusView,
  type FreeListView,
  type RankedFreeModelView,
  type ProviderIntelligenceView,
  type RadarEntryView,
  type RouteGroupView,
  type RouteOptionView,
  type Tri,
} from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Discover: what can I use, what does it cost, and how do I reach it.
 *
 * Three questions, three tabs. The radar answers "what is the best thing I can
 * use for nothing right now"; routes answer "this model — through whom";
 * providers answer "what are the terms".
 *
 * The design rule running through all of it is that an unconfirmed fact is
 * displayed as unconfirmed. A provider whose commercial-use permission nobody
 * has checked shows "unknown", not a reassuring blank, and the filters exclude
 * it rather than quietly counting it as a yes.
 */

type Tab = 'free' | 'radar' | 'routes' | 'providers';

/** Renders a tri-state the way it deserves: three outcomes, not two. */
function TriChip({ value, yes, no }: { value: Tri; yes: string; no: string }): React.JSX.Element {
  if (value === 'yes') return <StatusChip status="ready" size="sm" label={yes} />;
  if (value === 'no') return <StatusChip status="offline" size="sm" label={no} />;
  return <StatusChip status="unknown" size="sm" label="Unknown" />;
}

function price(v: number | null): string {
  if (v === null) return '—';
  if (v === 0) return 'Free';
  return v < 1 ? `$${v.toFixed(3)}/M` : `$${v.toFixed(2)}/M`;
}

function ms(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)} ms`;
}

/**
 * Route columns, defined once at module scope.
 *
 * Typed explicitly rather than inline so the row type survives: an inline
 * literal makes TypeScript infer `unknown` for the row and every accessor
 * silently loses its type.
 */
const ROUTE_COLUMNS: TableColumn<RouteOptionView>[] = [
  { key: 'provider', header: 'Provider', render: (o) => o.providerId },
  {
    key: 'price',
    header: 'Price',
    // "—" is not "free": an unpublished rate stays unpublished.
    render: (o) => <span className="mrd-numeric">{price(o.blendedPerMTok)}</span>,
  },
  { key: 'p95', header: 'p95', render: (o) => <span className="mrd-numeric">{ms(o.p95LatencyMs)}</span> },
  {
    key: 'reliability',
    header: 'Reliability',
    render: (o) => (
      <span className="mrd-numeric">
        {o.reliability === null ? 'unmeasured' : `${Math.round(o.reliability * 100)}%`}
      </span>
    ),
  },
  {
    key: 'state',
    header: 'State',
    render: (o) => (
      <StatusChip
        status={o.configured ? (o.health === 'healthy' ? 'ready' : 'unknown') : 'offline'}
        size="sm"
        label={o.configured ? o.health : 'Needs key'}
      />
    ),
  },
];

const PROVIDER_COLUMNS: TableColumn<ProviderIntelligenceView>[] = [
  {
    key: 'provider',
    header: 'Provider',
    render: (r) => (
      <Stack direction="column" gap={1}>
        <span>{r.providerId}</span>
        {r.bestFor && <span className="mrd-caption mrd-secondary">{r.bestFor}</span>}
      </Stack>
    ),
  },
  {
    key: 'access',
    header: 'Free access',
    render: (r) => (
      <Stack direction="column" gap={1}>
        <span>{r.freeAccess.replace(/_/g, ' ').toLowerCase()}</span>
        {r.freeTierSummary && (
          <span className="mrd-caption mrd-secondary mrd-truncate" style={{ maxWidth: 320 }}>
            {r.freeTierSummary}
          </span>
        )}
      </Stack>
    ),
  },
  { key: 'card', header: 'Card', render: (r) => <TriChip value={r.requirements.card} yes="Required" no="Not needed" /> },
  { key: 'phone', header: 'Phone', render: (r) => <TriChip value={r.requirements.phone} yes="Required" no="Not needed" /> },
  { key: 'commercial', header: 'Commercial', render: (r) => <TriChip value={r.commercialUse} yes="Allowed" no="Not allowed" /> },
  {
    key: 'verified',
    header: 'Source checked',
    render: (r) => (
      <span className="mrd-caption mrd-secondary mrd-numeric">{r.provenance.lastVerified ?? 'unknown'}</span>
    ),
  },
];

export function DiscoverScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('free');
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const toast = useStore((s) => s.toast);

  const loadStatus = useCallback(async () => {
    const r = await api.catalogStatus().catch(() => null);
    if (r) setStatus(r.status);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const { status: s } = await api.syncCatalog();
      setStatus(s);
      toast({
        level: s.status === 'updated' ? 'success' : 'info',
        message:
          s.status === 'updated'
            ? `Catalog updated to ${s.version} — ${s.registered} provider(s) registered`
            : `Catalog ${s.status.replace('-', ' ')}`,
        detail: s.error ?? undefined,
      });
    } catch (e) {
      toast({ level: 'error', message: 'Could not sync the catalog', detail: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Screen
      title="Discover"
      subtitle="Find the best free or low-cost model, and the cheapest way to reach it."
      actions={
        <Button variant="secondary" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync catalog'}
        </Button>
      }
    >
      <Stack direction="column" gap={4}>
        <CatalogBanner status={status} />

        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'free', label: 'Free inference' },
            { value: 'radar', label: 'Free radar' },
            { value: 'routes', label: 'Routes' },
            { value: 'providers', label: 'Providers & terms' },
          ]}
        />

        {tab === 'free' && <FreeInferenceTab />}
        {tab === 'radar' && <RadarTab />}
        {tab === 'routes' && <RoutesTab />}
        {tab === 'providers' && <ProvidersTab />}
      </Stack>
    </Screen>
  );
}

/**
 * Where the catalog came from and how old it is.
 *
 * Prominent rather than tucked away: every "free, no card" claim below is only
 * as good as this date, and a sync that failed today must not look like one
 * that succeeded.
 */
function CatalogBanner({ status }: { status: CatalogStatus | null }): React.JSX.Element {
  if (!status) return <span className="mrd-secondary">Loading catalog status…</span>;

  const stale = status.fromCache || status.status === 'stale-cache';
  const unavailable = status.status === 'unavailable';

  return (
    <Card>
      <Stack direction="column" gap={2}>
        <Stack direction="row" gap={2} align="center" wrap>
          <strong>Provider catalog</strong>
          <StatusChip
            status={unavailable ? 'offline' : stale ? 'degraded' : 'ready'}
            size="sm"
            label={
              unavailable
                ? 'Unavailable'
                : status.status === 'updated'
                  ? 'Up to date'
                  : status.status === 'not-modified'
                    ? 'Current'
                    : 'Cached'
            }
          />
          {status.version && <span className="mrd-caption mrd-numeric">v{status.version}</span>}
        </Stack>

        {unavailable ? (
          <span className="mrd-secondary">
            No catalog has been downloaded yet and the network was unavailable. Meridian is showing only its
            built-in providers — it has not guessed at any others.
          </span>
        ) : (
          <span className="mrd-secondary">
            {status.entries} providers from {status.source}
            {status.generated ? `, published ${status.generated}` : ''}. {status.registered} registered as new
            routes, {status.enriched} added detail to providers already built in.
            {stale
              ? ` Showing a cached copy${status.cacheAgeDays !== null ? ` from ${status.cacheAgeDays} day(s) ago` : ''}.`
              : ''}
          </span>
        )}

        {status.error && <span className="mrd-caption mrd-warn">Last sync problem: {status.error}</span>}
        <span className="mrd-caption mrd-secondary">{status.attribution}</span>
      </Stack>
    </Card>
  );
}


/* ------------------------------------------------------------------ */
/* Free inference                                                      */
/* ------------------------------------------------------------------ */

/**
 * Everything that costs nothing, in order, with the evidence attached.
 *
 * The radar tab answers this question from Meridian's own registry — models it
 * has descriptors for. This one answers it from the discovery engine, which
 * merges several independent catalogues and provider listings, and therefore
 * knows about things this instance is not configured for. Both are worth
 * having: one is "what can I use right now", the other is "what exists".
 *
 * Two display rules carry the whole design.
 *
 * **Nothing appears here on the strength of a repository's title.** A model
 * whose cost is not established is excluded, and the count of what was excluded
 * and why is shown — because "no free models found" and "everything was
 * excluded for reasons you can read" are different statements.
 *
 * **Every row can be opened.** The score is not a verdict from nowhere: the
 * reasons that produced it, the source that supplied the claim, and the date it
 * was last checked are all one click away, so a wrong answer can be traced
 * rather than argued with.
 */
function FreeInferenceTab(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<FreeListView | null>(null);
  const [status, setStatus] = useState<DiscoveryStatusView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [needs, setNeeds] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [free, s] = await Promise.all([
        api.freeInference({ requires: needs, includeNonFree: showAll, limit: 200 }),
        api.freeDiscoveryStatus(),
      ]);
      setList(free);
      setStatus(s.status);
      setNote(s.note);
    } catch (e) {
      toast({ level: 'error', message: 'Could not load free inference', detail: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [needs, showAll, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { status: s } = await api.refreshFreeDiscovery(true);
      setStatus(s);
      const failed = s.sources.filter((x) => !x.ok);
      toast({
        level: failed.length === 0 ? 'success' : 'info',
        message:
          failed.length === 0
            ? `Refreshed ${s.sources.length} sources — ${s.freeModels} free models`
            : `${s.sources.length - failed.length} of ${s.sources.length} sources refreshed`,
        detail: failed.length ? failed.map((x) => `${x.displayName}: ${x.error}`).join('\n') : undefined,
      });
      await load();
    } catch (e) {
      toast({ level: 'error', message: 'Refresh failed', detail: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list?.models ?? [];
    return (list?.models ?? []).filter(
      (m) => m.modelId.toLowerCase().includes(q) || m.providerId.toLowerCase().includes(q),
    );
  }, [list, search]);

  const toggle = (cap: string) =>
    setNeeds((current) => (current.includes(cap) ? current.filter((c) => c !== cap) : [...current, cap]));

  return (
    <Stack direction="column" gap={4}>
      <SourcesBanner status={status} note={note} onRefresh={() => void refresh()} refreshing={refreshing} />

      <Stack direction="row" gap={3} align="center" wrap>
        <SearchField
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder="Filter by model or provider"
          style={{ flex: 1, minWidth: 220 }}
        />
        {(['vision', 'tools', 'reasoning', 'imageGeneration', 'audio', 'embedding'] as const).map((cap) => (
          <Checkbox key={cap} checked={needs.includes(cap)} onChange={() => toggle(cap)} label={capabilityLabel(cap)} />
        ))}
        <Checkbox
          checked={showAll}
          onChange={() => setShowAll((v) => !v)}
          label="Include paid and unestablished"
        />
      </Stack>

      {loading && !list ? (
        <span className="mrd-secondary">Loading…</span>
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matched"
          description={
            list?.excluded.length
              ? `Everything was excluded: ${list.excluded.map((e) => `${e.count} ${e.reason}`).join(', ')}.`
              : 'No sources have loaded yet. Refresh to fetch them.'
          }
        />
      ) : (
        <Stack direction="column" gap={2}>
          <span className="mrd-caption mrd-secondary">
            {shown.length} of {list?.total ?? 0} shown.
            {list?.excluded.length
              ? ` Excluded: ${list.excluded.map((e) => `${e.count} because ${e.reason}`).join('; ')}.`
              : ''}
          </span>
          {shown.map((m) => (
            <FreeModelRow
              key={m.modelId}
              model={m}
              expanded={open === m.modelId}
              onToggle={() => setOpen(open === m.modelId ? null : m.modelId)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function capabilityLabel(cap: string): string {
  return cap === 'imageGeneration' ? 'Image generation' : cap.charAt(0).toUpperCase() + cap.slice(1);
}

/**
 * How the answer was assembled, before the answer.
 *
 * A source that failed and a source that returned nothing look identical in a
 * result list, and the difference decides whether the list is short because the
 * world is small or because half of it did not load.
 */
function SourcesBanner({
  status,
  note,
  onRefresh,
  refreshing,
}: {
  status: DiscoveryStatusView | null;
  note: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}): React.JSX.Element {
  if (!status) return <span className="mrd-secondary">Loading sources…</span>;
  const failed = status.sources.filter((s) => !s.ok);

  return (
    <Card>
      <Stack direction="column" gap={2}>
        <Stack direction="row" gap={2} align="center" wrap>
          <strong>Discovery sources</strong>
          <StatusChip
            status={failed.length === 0 ? 'ready' : failed.length === status.sources.length ? 'offline' : 'degraded'}
            size="sm"
            label={`${status.sources.length - failed.length}/${status.sources.length} loaded`}
          />
          <span className="mrd-caption mrd-numeric">
            {status.providers} providers · {status.models} models · {status.freeModels} free
          </span>
          <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh sources'}
          </Button>
        </Stack>

        {note && <span className="mrd-caption mrd-warn">{note}</span>}

        <Stack direction="column" gap={1}>
          {status.sources.map((s) => (
            <Stack key={s.id} direction="row" gap={2} align="center" wrap>
              <StatusChip status={s.ok ? 'ready' : 'offline'} size="sm" label={s.ok ? 'ok' : 'failed'} />
              <span>{s.displayName}</span>
              <span className="mrd-caption mrd-secondary">{s.sourceClass}</span>
              <span className="mrd-caption mrd-numeric">
                {s.providers} providers · {s.models} models
              </span>
              {s.fromCache && (
                <span className="mrd-caption mrd-secondary">
                  cached{s.cacheAgeDays !== null ? ` ${s.cacheAgeDays}d ago` : ''}
                </span>
              )}
              {s.error && <span className="mrd-caption mrd-warn">{s.error}</span>}
            </Stack>
          ))}
        </Stack>

        {status.refusals.length > 0 && (
          <span className="mrd-caption mrd-secondary">
            {status.refusals.map((r) => `${r.count} claims from ${r.sourceId} about ${r.field}`).join('; ')} were
            not used: the source had not declared that it observes them.
          </span>
        )}
      </Stack>
    </Card>
  );
}

/** One model, with its score openable into the reasons that produced it. */
function FreeModelRow({
  model,
  expanded,
  onToggle,
}: {
  model: RankedFreeModelView;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const caps = Object.entries(model.capabilities ?? {})
    .filter(([, v]) => v)
    .map(([k]) => capabilityLabel(k));

  return (
    <Card>
      <Stack direction="column" gap={2}>
        <Stack direction="row" gap={2} align="center" wrap>
          <StatusChip
            status={model.verdict === 'free' || model.verdict === 'free-locally' ? 'ready' : model.verdict === 'unknown' ? 'unknown' : 'degraded'}
            size="sm"
            label={model.accessLabel}
          />
          <strong>{model.providerModelId}</strong>
          <span className="mrd-caption mrd-secondary">{model.providerId}</span>
          {model.reachable === true && <StatusChip status="ready" size="sm" label="Configured" />}
          {model.reachable === false && <StatusChip status="unknown" size="sm" label="Needs a key" />}
          {model.contextLength && (
            <span className="mrd-caption mrd-numeric">{model.contextLength.toLocaleString()} ctx</span>
          )}
          {caps.length > 0 && <span className="mrd-caption mrd-secondary">{caps.join(' · ')}</span>}
          <Button variant="tertiary" size="sm" onClick={onToggle}>
            {expanded ? 'Hide why' : 'Why this rank'}
          </Button>
        </Stack>

        {model.freeQuota && (
          <span className="mrd-caption mrd-secondary">
            Published allowance:{' '}
            {[
              model.freeQuota.requestsPerMinute && `${model.freeQuota.requestsPerMinute}/min`,
              model.freeQuota.requestsPerDay && `${model.freeQuota.requestsPerDay}/day`,
              model.freeQuota.tokensPerMinute && `${model.freeQuota.tokensPerMinute.toLocaleString()} tok/min`,
              model.freeQuota.tokensPerDay && `${model.freeQuota.tokensPerDay.toLocaleString()} tok/day`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}

        {expanded && (
          <Stack direction="column" gap={1}>
            <span className="mrd-caption mrd-secondary">Score {model.score}, made up of:</span>
            {model.reasons.map((r) => (
              <span key={r} className="mrd-caption">
                · {r}
              </span>
            ))}
            <span className="mrd-caption mrd-secondary">
              Claimed by {model.contributors.join(', ')}. Cited from {model.provenance.source}
              {model.provenance.lastVerified ? `, last checked ${model.provenance.lastVerified}` : ', with no date attached'}
              {model.ageDays !== null ? ` (${model.ageDays} days ago)` : ''}.
            </span>
            {model.provenance.sourceUrl && (
              <a className="mrd-caption" href={model.provenance.sourceUrl} target="_blank" rel="noreferrer noopener">
                Check it yourself
              </a>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Free radar                                                          */
/* ------------------------------------------------------------------ */

function RadarTab(): React.JSX.Element {
  const [entries, setEntries] = useState<RadarEntryView[] | null>(null);
  const [includeUnconfigured, setIncludeUnconfigured] = useState(true);
  const [configured, setConfigured] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .freeRadar({ limit: 40, includeUnconfigured })
      .then((r) => {
        if (!cancelled) {
          setEntries(r.entries);
          setConfigured(r.configuredProviders);
        }
      })
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [includeUnconfigured]);

  const columns = useMemo<TableColumn<RadarEntryView>[]>(
    () => [
      {
        key: 'score',
        header: 'Score',
        width: '74px',
        render: (e) => <span className="mrd-numeric">{e.score.toFixed(1)}</span>,
      },
      {
        key: 'model',
        header: 'Model',
        render: (e) => (
          <Stack direction="column" gap={1}>
            <span>{e.option.displayName}</span>
            <span className="mrd-caption mrd-secondary">{e.option.providerId}</span>
          </Stack>
        ),
      },
      {
        key: 'why',
        header: 'Why',
        // The score is never a black box: the factors behind it are shown.
        render: (e) => (
          <span className="mrd-caption mrd-secondary mrd-numeric">
            q {e.factors.quality} · rel {e.factors.reliability} · up {e.factors.availability} · spd{' '}
            {e.factors.speed}
          </span>
        ),
      },
      {
        key: 'access',
        header: 'Access',
        render: (e) => (
          <StatusChip
            status={e.option.local ? 'ready' : 'unknown'}
            size="sm"
            label={e.option.local ? 'Local' : (e.option.freeAccess ?? 'Free')}
          />
        ),
      },
      {
        key: 'state',
        header: 'State',
        render: (e) => (
          <Stack direction="column" gap={1}>
            <StatusChip
              status={e.option.configured ? (e.option.health === 'healthy' ? 'ready' : 'unknown') : 'offline'}
              size="sm"
              label={e.option.configured ? e.option.health : 'Needs key'}
            />
            <span className="mrd-caption mrd-secondary">{e.note}</span>
          </Stack>
        ),
      },
    ],
    [],
  );

  if (!entries) return <span className="mrd-secondary">Scanning…</span>;

  return (
    <Stack direction="column" gap={3}>
      <Stack direction="row" gap={3} align="center" wrap>
        <Checkbox
          checked={includeUnconfigured}
          onChange={(e) => setIncludeUnconfigured(e.target.checked)}
          label="Include models that need an API key"
        />
        <span className="mrd-caption mrd-secondary">
          {configured} provider(s) currently have a credential.
        </span>
      </Stack>

      {entries.length === 0 ? (
        <EmptyState
          title="No free models available yet"
          description={
            configured === 0
              ? 'No provider has a credential yet. Add a key on the Providers screen, or start a local model server, and free options will appear here.'
              : 'Nothing configured right now offers a zero-cost route. Trial credit is deliberately excluded — it is cheap, not free.'
          }
        />
      ) : (
        <Table rows={entries} columns={columns} rowKey={(e) => e.option.modelId} caption="Best free models available now" />
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function RoutesTab(): React.JSX.Element {
  const [groups, setGroups] = useState<RouteGroupView[] | null>(null);
  const [multiOnly, setMultiOnly] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api
      .routes({ multiOnly, q: search, limit: 60 })
      .then((r) => !cancelled && setGroups(r.groups))
      .catch(() => !cancelled && setGroups([]));
    return () => {
      cancelled = true;
    };
  }, [multiOnly, search]);

  if (!groups) return <span className="mrd-secondary">Loading routes…</span>;

  return (
    <Stack direction="column" gap={3}>
      <Stack direction="row" gap={3} align="center" wrap>
        <SearchField
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder="Filter models…"
        />
        <Checkbox
          checked={multiOnly}
          onChange={(e) => setMultiOnly(e.target.checked)}
          label="Only models with more than one route"
        />
      </Stack>

      {groups.length === 0 ? (
        <EmptyState
          title="No routes to compare"
          description="Route comparison needs the same model from more than one provider. Discover more providers, or clear the filter above."
        />
      ) : (
        <Stack direction="column" gap={3}>
          {groups.map((g) => (
            <RouteGroupCard key={g.key} group={g} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RouteGroupCard({ group }: { group: RouteGroupView }): React.JSX.Element {
  return (
    <Card>
      <Stack direction="column" gap={2}>
        <Stack direction="row" gap={2} align="center" wrap>
          <strong>{group.displayName}</strong>
          <span className="mrd-caption mrd-secondary">
            {group.options.length} route{group.options.length === 1 ? '' : 's'}
          </span>
          {group.cheapest && (
            <StatusChip status="ready" size="sm" label={`Cheapest: ${group.cheapest.providerId}`} />
          )}
          {group.fastest && (
            <StatusChip status="unknown" size="sm" label={`Fastest: ${group.fastest.providerId}`} />
          )}
          {group.localRoute && <StatusChip status="ready" size="sm" label="Local available" />}
        </Stack>

        <Table
          rows={group.options}
          rowKey={(o) => o.modelId}
          caption={`Routes for ${group.displayName}`}
          columns={ROUTE_COLUMNS}
        />
      </Stack>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Providers and terms                                                 */
/* ------------------------------------------------------------------ */

function ProvidersTab(): React.JSX.Element {
  const [rows, setRows] = useState<ProviderIntelligenceView[] | null>(null);
  const [free, setFree] = useState(false);
  const [noCard, setNoCard] = useState(false);
  const [commercial, setCommercial] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .catalogIntelligence({ free, noCard, commercial })
      .then((r) => !cancelled && setRows(r.providers))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [free, noCard, commercial]);

  if (!rows) return <span className="mrd-secondary">Loading providers…</span>;

  return (
    <Stack direction="column" gap={3}>
      <Stack direction="row" gap={3} align="center" wrap>
        <Checkbox checked={free} onChange={(e) => setFree(e.target.checked)} label="Costs nothing now" />
        <Checkbox checked={noCard} onChange={(e) => setNoCard(e.target.checked)} label="No card required" />
        <Checkbox
          checked={commercial}
          onChange={(e) => setCommercial(e.target.checked)}
          label="Commercial use allowed"
        />
      </Stack>

      <span className="mrd-caption mrd-secondary">
        Filters match only what has been confirmed. A provider whose terms nobody has checked is excluded
        rather than assumed to qualify — {rows.length} shown.
      </span>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="No provider is confirmed to meet all of these conditions. Relax a filter to include providers whose terms are unconfirmed."
        />
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => r.providerId}
          caption="Providers and their terms"
          columns={PROVIDER_COLUMNS}
        />
      )}
    </Stack>
  );
}
