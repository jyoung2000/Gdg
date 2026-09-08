import { useEffect, useState } from 'react';
import { Card, EmptyState, SegmentedControl, Stack, StatusChip, Table, IconBarChart, type TableColumn } from '@meridian/ui';
import { formatCost, formatRelative, type UsageRecord } from '@meridian/shared';
import { api, type RequestTrace, type UsageSummary } from '../lib/api.js';
import { Screen } from './Screen.js';

/**
 * Usage, cost and reliability.
 *
 * The chart is hand-drawn SVG rather than a charting dependency: one series of
 * daily totals does not justify shipping a library, and inline SVG inherits the
 * theme tokens without a second theming mechanism.
 */
export function UsageScreen(): React.JSX.Element {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [recent, setRecent] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<RequestTrace | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void api
      .usage(days)
      .then((r) => {
        setSummary(r.summary);
        setRecent(r.recent);
      })
      .finally(() => setLoading(false));
  }, [days]);

  // Selecting a call asks the gateway what the whole request did, rather than
  // rendering the one row already in hand: a request can be several attempts,
  // and the failed ones are the interesting half.
  useEffect(() => {
    if (!selected) {
      setTrace(null);
      setTraceError(null);
      return;
    }
    let cancelled = false;
    setTraceError(null);
    void api
      .trace(selected)
      .then((t) => {
        if (!cancelled) setTrace(t);
      })
      .catch(() => {
        if (!cancelled) {
          setTrace(null);
          setTraceError('That request is no longer on record.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const modelColumns: TableColumn<UsageSummary['byModel'][number]>[] = [
    { key: 'model', header: 'Model', render: (r) => <span className="mrd-truncate mrd-code">{r.modelId}</span> },
    { key: 'requests', header: 'Requests', width: '100px', align: 'end', sortable: true, render: (r) => <span className="mrd-numeric">{r.requests}</span> },
    { key: 'tokens', header: 'Tokens', width: '120px', align: 'end', sortable: true, render: (r) => <span className="mrd-numeric">{r.tokens.toLocaleString()}</span> },
    { key: 'cost', header: 'Cost', width: '100px', align: 'end', sortable: true, render: (r) => <span className="mrd-numeric">{formatCost(r.cost)}</span> },
    { key: 'latency', header: 'Avg latency', width: '110px', align: 'end', render: (r) => <span className="mrd-numeric">{(r.avgLatency / 1000).toFixed(2)}s</span> },
    {
      key: 'success',
      header: 'Success',
      width: '110px',
      align: 'end',
      render: (r) => (
        <StatusChip status={r.successRate > 0.95 ? 'ready' : r.successRate > 0.8 ? 'degraded' : 'offline'} label={`${Math.round(r.successRate * 100)}%`} size="sm" />
      ),
    },
  ];

  const recentColumns: TableColumn<UsageRecord>[] = [
    { key: 'at', header: 'When', width: '110px', render: (r) => formatRelative(r.at, Date.now()) },
    { key: 'model', header: 'Model', render: (r) => <span className="mrd-truncate mrd-code">{r.modelId}</span> },
    { key: 'task', header: 'Task type', width: '110px', render: (r) => r.taskType },
    { key: 'tokens', header: 'Tokens', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{r.promptTokens + r.completionTokens}</span> },
    { key: 'cost', header: 'Cost', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{formatCost(r.cost)}</span> },
    { key: 'fallbacks', header: 'Fallbacks', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{r.fallbackCount || '—'}</span> },
    { key: 'ok', header: '', width: '110px', render: (r) => <StatusChip status={r.success ? 'ready' : 'degraded'} label={r.success ? 'ok' : (r.errorCode ?? 'failed')} size="sm" /> },
  ];

  return (
    <Screen
      title="Usage"
      subtitle="Every call Meridian served, with what it cost and how it behaved."
      actions={
        <SegmentedControl
          size="sm"
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={[
            { value: '1', label: '24h' },
            { value: '7', label: '7d' },
            { value: '30', label: '30d' },
            { value: '90', label: '90d' },
          ]}
        />
      }
    >
      {!summary || (summary.totals.requests === 0 && !loading) ? (
        <EmptyState
          icon={<IconBarChart />}
          title="Nothing recorded yet"
          description="Usage appears here as soon as Meridian serves a request — through the app, the CLI, or the OpenAI- and Anthropic-compatible APIs."
        />
      ) : (
        <>
          <div className="app__grid">
            <Metric label="Requests" value={summary.totals.requests.toLocaleString()} note={`over ${days} days`} />
            <Metric label="Tokens" value={summary.totals.tokens.toLocaleString()} note="prompt and completion" />
            <Metric label="Cost" value={formatCost(summary.totals.cost)} note={summary.totals.cost === 0 ? 'entirely free capacity' : 'across all providers'} />
            <Metric
              label="Recovered failures"
              value={String(summary.totals.fallbacks)}
              note={`${summary.totals.failures} unrecovered`}
            />
          </div>

          {summary.byDay.length > 1 && (
            <section>
              <h2 className="mrd-panel-title">Daily volume</h2>
              <Card>
                <DailyChart data={summary.byDay} />
              </Card>
            </section>
          )}

          <section>
            <h2 className="mrd-panel-title">By model</h2>
            <Table columns={modelColumns} rows={summary.byModel} rowKey={(r) => r.modelId} empty="No model usage." />
          </section>

          <section>
            <h2 className="mrd-panel-title">By provider</h2>
            <Stack direction="column" gap={2}>
              {summary.byProvider.map((p) => (
                <Card key={p.providerId}>
                  <Stack direction="row" gap={3} align="center">
                    <span className="mrd-body">{p.providerId}</span>
                    <div className="mrd-spacer" />
                    <span className="mrd-caption mrd-numeric">{p.requests} requests</span>
                    <span className="mrd-caption mrd-numeric">{formatCost(p.cost)}</span>
                    <StatusChip
                      status={p.errorRate < 0.02 ? 'ready' : p.errorRate < 0.15 ? 'degraded' : 'offline'}
                      label={`${Math.round(p.errorRate * 100)}% errors`}
                      size="sm"
                    />
                  </Stack>
                </Card>
              ))}
            </Stack>
          </section>

          <section>
            <h2 className="mrd-panel-title">Recent calls</h2>
            <Table
              columns={recentColumns}
              rows={recent.slice(0, 100)}
              rowKey={(r) => r.id}
              empty="No calls."
              selectedKey={recent.find((r) => r.requestId === selected)?.id ?? null}
              onSelectRow={(r) => setSelected(r.requestId === selected ? null : r.requestId)}
            />
            <p className="mrd-caption">Select a call to see every attempt the request made and why it went where it did.</p>
          </section>

          {selected && (
            <section>
              {/* The id is set in code and never in the panel title: that title
                  is upper-cased by the design system, and an upper-cased
                  request id is one a person cannot copy back into a support
                  ticket or `uag trace`. */}
              <h2 className="mrd-panel-title">Request trace</h2>
              <p className="mrd-code">{selected}</p>
              {traceError ? <Card>{traceError}</Card> : trace ? <TracePanel trace={trace} /> : <Card>Loading…</Card>}
            </section>
          )}
        </>
      )}
    </Screen>
  );
}

/**
 * What one request actually did.
 *
 * Ordered oldest first and showing every attempt, not just the one that
 * worked. A request that took three tries across two providers reads as one
 * line per try here; collapsing it to the winner would answer the easy
 * question and hide the expensive one.
 */
function TracePanel({ trace }: { trace: RequestTrace }): React.JSX.Element {
  const winner = trace.attempts.find((a) => a.success) ?? null;
  const routing = trace.attempts.find((a) => a.routing)?.routing ?? null;

  return (
    <Stack direction="column" gap={3}>
      <Card>
        <Stack direction="row" gap={3} align="center" wrap>
          <StatusChip
            status={trace.summary.succeeded ? 'ready' : 'offline'}
            label={trace.summary.succeeded ? 'served' : 'failed'}
            size="sm"
          />
          <span className="mrd-caption mrd-numeric">
            {trace.summary.attempts} attempt{trace.summary.attempts === 1 ? '' : 's'}
          </span>
          <span className="mrd-caption mrd-numeric">
            {(trace.summary.promptTokens + trace.summary.completionTokens).toLocaleString()} tokens
          </span>
          <span className="mrd-caption mrd-numeric">{formatCost(trace.summary.cost)}</span>
          {/* Null and zero mean different things here, and only one of them is
              a saving worth reporting. */}
          {trace.summary.contextTokensSaved != null && (
            <span className="mrd-caption mrd-numeric">
              {trace.summary.contextTokensSaved.toLocaleString()} tokens saved by optimisation
            </span>
          )}
          {winner && <span className="mrd-caption mrd-code mrd-truncate">{winner.modelId}</span>}
        </Stack>
      </Card>

      {routing ? (
        <Card>
          <Stack direction="column" gap={2}>
            <span className="mrd-panel-title">Why this model</span>
            <span className="mrd-body">{routing.summary}</span>
            <span className="mrd-caption">
              Ran under {routing.mode}
              {routing.requestedMode !== routing.mode ? ` — asked for ${routing.requestedMode}` : ''}
            </span>
            {routing.considered.length > 0 && (
              <Stack direction="column" gap={1}>
                {routing.considered.map((cand) => (
                  <Stack key={cand.modelId} direction="row" gap={2} align="center">
                    <span className="mrd-caption mrd-code mrd-truncate">{cand.modelId}</span>
                    <div className="mrd-spacer" />
                    <span className="mrd-caption mrd-numeric">{cand.score.toFixed(2)}</span>
                    <span className="mrd-caption mrd-numeric">
                      {/* An unpublished price is never rendered as $0.00. */}
                      {cand.estimatedCost == null ? 'price unknown' : formatCost(cand.estimatedCost)}
                    </span>
                  </Stack>
                ))}
              </Stack>
            )}
            {routing.rejected.length > 0 && (
              <span className="mrd-caption">
                Ruled out: {routing.rejected.slice(0, 3).map((r) => `${r.count} × ${r.reason.toLowerCase()}`).join(', ')}
              </span>
            )}
          </Stack>
        </Card>
      ) : (
        <Card>
          <span className="mrd-caption">
            No routing decision was recorded for this request — it predates the trace, or it did not go through the router.
          </span>
        </Card>
      )}

      <Table
        columns={[
          { key: 'at', header: 'When', width: '110px', render: (r: UsageRecord) => formatRelative(r.at, Date.now()) },
          { key: 'model', header: 'Model', render: (r: UsageRecord) => <span className="mrd-truncate mrd-code">{r.modelId}</span> },
          { key: 'latency', header: 'Latency', width: '100px', align: 'end', render: (r: UsageRecord) => <span className="mrd-numeric">{(r.latencyMs / 1000).toFixed(2)}s</span> },
          { key: 'cost', header: 'Cost', width: '90px', align: 'end', render: (r: UsageRecord) => <span className="mrd-numeric">{formatCost(r.cost)}</span> },
          {
            key: 'ok',
            header: '',
            width: '120px',
            render: (r: UsageRecord) => (
              <StatusChip status={r.success ? 'ready' : 'degraded'} label={r.success ? 'ok' : (r.errorCode ?? 'failed')} size="sm" />
            ),
          },
        ]}
        rows={trace.attempts}
        rowKey={(r) => r.id}
        caption="Every attempt this request made"
        empty="No attempts recorded."
      />

      {trace.toolCalls.length > 0 && (
        <Table
          columns={[
            { key: 'name', header: 'Tool', render: (c: RequestTrace['toolCalls'][number]) => <span className="mrd-code mrd-truncate">{c.name}</span> },
            { key: 'ms', header: 'Duration', width: '110px', align: 'end', render: (c) => <span className="mrd-numeric">{c.durationMs}ms</span> },
            {
              key: 'ok',
              header: '',
              width: '110px',
              render: (c) => <StatusChip status={c.error ? 'degraded' : 'ready'} label={c.error ? 'failed' : 'ok'} size="sm" />,
            },
          ]}
          rows={trace.toolCalls}
          rowKey={(c) => c.id}
          caption="Tools this step called"
        />
      )}
    </Stack>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }): React.JSX.Element {
  return (
    <Card>
      <Stack direction="column" gap={1}>
        <span className="mrd-caption">{label}</span>
        <span className="mrd-title mrd-numeric">{value}</span>
        <span className="mrd-caption">{note}</span>
      </Stack>
    </Card>
  );
}

/** Daily request volume. Bars, because the series is discrete and gappy. */
function DailyChart({ data }: { data: { day: string; requests: number; cost: number }[] }): React.JSX.Element {
  const width = 720;
  const height = 140;
  const pad = 20;
  const max = Math.max(1, ...data.map((d) => d.requests));
  const barWidth = Math.max(2, (width - pad * 2) / data.length - 2);

  return (
    <div className="mrd-overflow-guard">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Daily request volume over ${data.length} days, peaking at ${max} requests`}
      >
        {data.map((d, i) => {
          const h = Math.max(1, ((height - pad * 2) * d.requests) / max);
          const x = pad + i * ((width - pad * 2) / data.length);
          return (
            <rect
              key={d.day}
              x={x}
              y={height - pad - h}
              width={barWidth}
              height={h}
              rx="2"
              fill="var(--color-accent)"
              opacity={d.cost > 0 ? 1 : 0.55}
            >
              <title>{`${d.day}: ${d.requests} requests, ${formatCost(d.cost)}`}</title>
            </rect>
          );
        })}
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--color-separator)" strokeWidth="1" />
      </svg>
      <p className="mrd-caption">Solid bars include paid calls; lighter bars were served entirely by free capacity.</p>
    </div>
  );
}
