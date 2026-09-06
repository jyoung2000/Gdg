import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DataUsePolicy,
  GenerationJob,
  InferencePool,
  ModelDescriptor,
  ModelPerformance,
  ModelScores,
  PricingKind,
  ProviderDescriptor,
  ProviderHealth,
  Reservation,
  RoutingReason,
  TrustLevel,
} from '@meridian/shared';
import { Button, IconButton } from '../primitives/Button.js';
import { Badge, SegmentedControl, Skeleton, Stars, StatusChip } from '../primitives/Controls.js';
import { SearchField } from '../primitives/Form.js';
import { Card, EmptyState, Stack } from '../layouts/Layout.js';
import { KeyValue, List, ListRow } from '../components/Data.js';
import { cx } from '../primitives/util.js';
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconInfo,
  IconLock,
  IconServer,
  IconShield,
  IconSparkle,
} from '../icons/icons.js';

/* ------------------------------------------------------------------ */
/* Honest labels                                                      */
/* ------------------------------------------------------------------ */

const PRICING_LABEL: Record<PricingKind, string> = {
  FREE: 'Free',
  FREE_DAILY: 'Free (daily limit)',
  FREE_MONTHLY: 'Free (monthly limit)',
  TRIAL: 'Trial credit',
  CREDIT: 'Promotional credit',
  FLAT: 'Flat rate',
  RESERVATION: 'Reserved capacity',
  METERED: 'Metered',
  LOCAL: 'Local',
  PAID: 'Paid',
  UNKNOWN: 'Pricing unknown',
};

export interface PricingLabelProps {
  kind: PricingKind;
  note?: string | null;
  inputPerMTok?: number | null;
  className?: string;
}

/**
 * Pricing, stated honestly.
 *
 * A trial or promotional credit is never rendered as "Free": both expire, and
 * a user who plans around "free" and is then billed has been misled by the
 * interface, not by the provider.
 */
export function PricingLabel({ kind, note, inputPerMTok, className }: PricingLabelProps): React.JSX.Element {
  const free = kind === 'FREE' || kind === 'FREE_DAILY' || kind === 'FREE_MONTHLY' || kind === 'LOCAL';
  const detail = inputPerMTok != null && inputPerMTok > 0 ? `$${inputPerMTok.toFixed(2)}/M in` : null;
  return (
    <span className={cx('mrd-pricing', className)} title={note ?? undefined}>
      <StatusChip status={free ? 'ready' : kind === 'UNKNOWN' ? 'unknown' : 'degraded'} label={PRICING_LABEL[kind]} size="sm" />
      {detail && <span className="mrd-caption mrd-numeric">{detail}</span>}
    </span>
  );
}

const TRUST_COPY: Record<TrustLevel, string> = {
  verified: 'You have verified this provider yourself.',
  trusted: 'A known provider with published terms.',
  unknown: 'Not assessed. Avoid sending private code or personal data.',
  untrusted: 'Explicitly marked untrusted. Excluded from most routing.',
};

export function TrustLabel({ trust, className }: { trust: TrustLevel; className?: string }): React.JSX.Element {
  return (
    <span className={cx('mrd-trust', className)} title={TRUST_COPY[trust]}>
      {trust === 'verified' ? <IconShield /> : trust === 'untrusted' ? <IconLock /> : <IconInfo />}
      <span className="mrd-caption">{trust}</span>
    </span>
  );
}

const DATA_USE_LABEL: Record<'allowed' | 'not_allowed' | 'unknown', string> = {
  allowed: 'Allowed',
  not_allowed: 'Not allowed',
  unknown: 'Unknown',
};

/**
 * A provider's data-use policy.
 *
 * "Unknown" is displayed as unknown. Meridian ships no guesses here, because a
 * confident wrong answer about whether your code trains someone's model is
 * worse than no answer at all.
 */
export function DataUseTable({ policy, className }: { policy: DataUsePolicy; className?: string }): React.JSX.Element {
  return (
    <div className={cx('mrd-datause', className)}>
      <KeyValue
        items={[
          { label: 'Trains on your content', value: <DataUseValue value={policy.trainingUse} /> },
          { label: 'Commercial use of output', value: <DataUseValue value={policy.commercialUse} /> },
          { label: 'Retention', value: policy.retention ?? <span className="mrd-caption">Unknown</span> },
        ]}
      />
      {policy.privacyNote && <p className="mrd-caption">{policy.privacyNote}</p>}
      {policy.policyUrl && (
        <a className="mrd-datause__link mrd-caption" href={policy.policyUrl} target="_blank" rel="noreferrer noopener">
          <IconExternalLink /> Read the provider’s policy
        </a>
      )}
    </div>
  );
}

function DataUseValue({ value }: { value: 'allowed' | 'not_allowed' | 'unknown' }): React.JSX.Element {
  if (value === 'unknown') return <span className="mrd-caption">Unknown — not verified by this instance</span>;
  return <StatusChip status={value === 'not_allowed' ? 'ready' : 'degraded'} label={DATA_USE_LABEL[value]} size="sm" />;
}

/* ------------------------------------------------------------------ */
/* Cards                                                              */
/* ------------------------------------------------------------------ */

export interface ModelCardProps {
  model: ModelDescriptor & { free?: boolean };
  scores?: ModelScores | null;
  performance?: ModelPerformance | null;
  selected?: boolean;
  onSelect?: () => void;
  onUse?: () => void;
  onBenchmark?: () => void;
  benchmarking?: boolean;
  className?: string;
}

/**
 * A model, with what is actually known about it.
 *
 * Anything never measured reads "Not measured" rather than showing a zero. A
 * zero would rank a brand-new model below a demonstrably bad one, and a user
 * cannot tell those apart from a number alone.
 */
export function ModelCard({
  model,
  scores,
  performance,
  selected,
  onSelect,
  onUse,
  onBenchmark,
  benchmarking,
  className,
}: ModelCardProps): React.JSX.Element {
  const measured = (scores?.samples ?? 0) > 0;
  const free = model.free ?? ['FREE', 'FREE_DAILY', 'FREE_MONTHLY', 'LOCAL'].includes(model.pricing.kind);

  return (
    <Card className={cx('mrd-modelcard', selected && 'mrd-modelcard--selected', className)}>
      <Stack direction="column" gap={3}>
        <Stack direction="row" gap={2} align="center">
          <span className="mrd-section-title mrd-truncate" title={model.id}>
            {model.displayName}
          </span>
          <div className="mrd-spacer" />
          {onSelect && (
            <IconButton
              label={selected ? `Deselect ${model.displayName}` : `Select ${model.displayName} to compare`}
              icon={selected ? <IconCheck /> : <IconCopy />}
              size="sm"
              pressed={selected}
              onClick={onSelect}
            />
          )}
        </Stack>
        <span className="mrd-caption mrd-truncate">{model.providerId}</span>

        <div className="mrd-modelcard__scores">
          <ScoreRow label="Coding" value={scores?.coding ?? null} measured={measured} />
          <ScoreRow label="Reasoning" value={scores?.reasoning ?? null} measured={measured} />
        </div>

        <KeyValue
          items={[
            { label: 'Tool use', value: model.capabilities.includes('tools') ? <IconCheck /> : <span className="mrd-caption">no</span> },
            { label: 'Context', value: model.contextLength ? formatContext(model.contextLength) : <span className="mrd-caption">unpublished</span> },
            {
              label: 'Latency',
              value: performance?.latencyMs ? `${(performance.latencyMs / 1000).toFixed(1)}s` : <span className="mrd-caption">Not measured</span>,
            },
            {
              label: 'Stability',
              value: scores?.stability != null ? `${Math.round(scores.stability * 100)}%` : <span className="mrd-caption">Not measured</span>,
            },
          ]}
        />

        <Stack direction="row" gap={2} align="center" wrap>
          <PricingLabel kind={model.pricing.kind} note={model.pricing.note} inputPerMTok={model.pricing.inputPerMTok} />
          {model.tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="neutral">
              {t}
            </Badge>
          ))}
        </Stack>

        <Stack direction="row" gap={2} align="center">
          <span className="mrd-caption">
            Best for: {measured ? bestFor(scores) : 'not yet measured'}
          </span>
          <div className="mrd-spacer" />
          {onBenchmark && (
            <Button size="sm" variant="tertiary" loading={benchmarking} onClick={onBenchmark}>
              Benchmark
            </Button>
          )}
          {onUse && (
            <Button size="sm" variant="secondary" onClick={onUse}>
              Use
            </Button>
          )}
        </Stack>
        {!free && <span className="mrd-caption">Routing here spends money and needs explicit permission.</span>}
      </Stack>
    </Card>
  );
}

function ScoreRow({ label, value, measured }: { label: string; value: number | null; measured: boolean }): React.JSX.Element {
  return (
    <div className="mrd-modelcard__score">
      <span className="mrd-caption">{label}</span>
      {measured && value != null ? (
        <Stars value={Math.round((value / 100) * 5)} label={`${label}: ${Math.round((value / 100) * 5)} out of 5`} />
      ) : (
        <span className="mrd-caption">Not measured</span>
      )}
    </div>
  );
}

function bestFor(scores: ModelScores | null | undefined): string {
  if (!scores) return 'not yet measured';
  const ranked = (
    [
      ['Coding', scores.coding],
      ['Reasoning', scores.reasoning],
      ['General', scores.general],
    ] as [string, number | null][]
  )
    .filter((e): e is [string, number] => e[1] != null)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return 'not yet measured';
  const [top, second] = ranked;
  return second && top[1] - second[1] < 6 ? `${top[0]} / ${second[0]}` : top[0];
}

export interface ProviderCardProps {
  provider: ProviderDescriptor;
  health: ProviderHealth;
  supportState: string;
  models: number;
  freeModels: number;
  paidModels: number;
  cooldownSec?: number | null;
  onManage?: () => void;
  onVerify?: () => void;
  verifying?: boolean;
  className?: string;
}

export function ProviderCard({
  provider,
  health,
  supportState,
  models,
  freeModels,
  paidModels,
  cooldownSec,
  onManage,
  onVerify,
  verifying,
  className,
}: ProviderCardProps): React.JSX.Element {
  return (
    <Card className={cx('mrd-providercard', className)}>
      <Stack direction="column" gap={3}>
        <Stack direction="row" gap={2} align="center">
          <IconServer />
          <span className="mrd-section-title mrd-truncate">{provider.name}</span>
          <div className="mrd-spacer" />
          <StatusChip status={healthStatus(health, supportState)} label={supportLabel(supportState, health)} size="sm" />
        </Stack>

        {cooldownSec != null && cooldownSec > 0 && (
          <span className="mrd-caption">Cooling down for another {cooldownSec}s after repeated failures.</span>
        )}

        <KeyValue
          items={[
            { label: 'Models', value: models === 0 ? <span className="mrd-caption">none discovered</span> : `${models} (${freeModels} free, ${paidModels} paid)` },
            { label: 'Latency', value: health.latencyMs ? `${(health.latencyMs / 1000).toFixed(2)}s` : <span className="mrd-caption">Not measured</span> },
            { label: 'Error rate', value: `${Math.round(health.errorRate * 100)}%` },
            { label: 'Auth', value: provider.auth === 'none' ? 'No credential needed' : provider.auth },
          ]}
        />

        <Stack direction="row" gap={2} align="center" wrap>
          <TrustLabel trust={provider.trust} />
          {provider.local && <Badge variant="success">Local</Badge>}
          {provider.kinds.slice(0, 3).map((k) => (
            <Badge key={k} variant="neutral">
              {k}
            </Badge>
          ))}
        </Stack>

        <Stack direction="row" gap={2}>
          {onVerify && (
            <Button size="sm" variant="tertiary" loading={verifying} onClick={onVerify}>
              Verify
            </Button>
          )}
          <div className="mrd-spacer" />
          {onManage && (
            <Button size="sm" variant="secondary" onClick={onManage}>
              Manage
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

function healthStatus(health: ProviderHealth, supportState: string): 'ready' | 'busy' | 'rate_limited' | 'degraded' | 'offline' | 'unknown' {
  if (supportState === 'not_configured' || supportState === 'unavailable') return 'unknown';
  if (health.circuit === 'open') return 'offline';
  switch (health.state) {
    case 'healthy':
      return 'ready';
    case 'rate_limited':
      return 'rate_limited';
    case 'degraded':
      return 'degraded';
    case 'offline':
    case 'unauthorized':
      return 'offline';
    default:
      return 'unknown';
  }
}

function supportLabel(supportState: string, health: ProviderHealth): string {
  if (supportState === 'not_configured') return 'Not configured';
  if (supportState === 'unavailable') return 'Unavailable';
  if (supportState === 'experimental') return 'Not verified';
  return health.circuit === 'open' ? 'Cooling down' : 'Healthy';
}

export interface PoolCardProps {
  pool: InferencePool;
  usage?: { inFlight: number; spentToday: number };
  concurrencyLimit?: number | null;
  budgetLimit?: number | null;
  activeReservation?: Reservation | null;
  onEdit?: () => void;
  onReserve?: () => void;
  className?: string;
}

export function PoolCard({ pool, usage, concurrencyLimit, budgetLimit, activeReservation, onEdit, onReserve, className }: PoolCardProps): React.JSX.Element {
  return (
    <Card className={cx('mrd-poolcard', className)}>
      <Stack direction="column" gap={3}>
        <Stack direction="row" gap={2} align="center">
          <span className="mrd-section-title mrd-truncate">{pool.name}</span>
          <div className="mrd-spacer" />
          {pool.builtin && <Badge variant="neutral">built-in</Badge>}
          <StatusChip status={pool.enabled ? 'ready' : 'offline'} label={pool.strategy} size="sm" />
        </Stack>

        {pool.description && <p className="mrd-secondary">{pool.description}</p>}

        <KeyValue
          items={[
            {
              label: 'Members',
              value: pool.members.length ? `${pool.members.length}: ${pool.members.slice(0, 2).map((m) => m.modelId).join(', ')}` : 'any eligible model',
            },
            { label: 'Fallback', value: pool.fallbackPoolId ?? <span className="mrd-caption">none</span> },
            { label: 'Concurrency', value: concurrencyLimit == null ? <span className="mrd-caption">unlimited</span> : String(concurrencyLimit) },
            {
              label: 'Daily budget',
              value:
                budgetLimit == null ? (
                  <span className="mrd-caption">unlimited</span>
                ) : budgetLimit === 0 ? (
                  'no spend'
                ) : (
                  `$${budgetLimit.toFixed(2)}`
                ),
            },
            { label: 'Spent today', value: usage ? `$${usage.spentToday.toFixed(4)}` : '—' },
          ]}
        />

        {activeReservation && (
          <span className="mrd-caption">
            Reservation “{activeReservation.label}” is active until {new Date(activeReservation.endAt).toLocaleTimeString()}.
          </span>
        )}

        <Stack direction="row" gap={2}>
          {onReserve && (
            <Button size="sm" variant="tertiary" onClick={onReserve}>
              Reserve
            </Button>
          )}
          <div className="mrd-spacer" />
          {onEdit && (
            <Button size="sm" variant="secondary" onClick={onEdit}>
              Edit
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

export interface TaskCardProps {
  lane: string;
  title: string;
  status: string;
  elapsedMs?: number;
  model?: string | null;
  currentStep?: string | null;
  onCancel?: () => void;
  onOpen?: () => void;
  className?: string;
}

export function TaskCard({ lane, title, status, elapsedMs, model, currentStep, onCancel, onOpen, className }: TaskCardProps): React.JSX.Element {
  return (
    <Card className={cx('mrd-taskcard', className)}>
      <Stack direction="column" gap={2}>
        <Stack direction="row" gap={2} align="center">
          <span className="mrd-section-title mrd-truncate">{lane}</span>
          <div className="mrd-spacer" />
          <StatusChip
            status={status === 'completed' ? 'ready' : status === 'running' ? 'busy' : status === 'failed' ? 'degraded' : 'unknown'}
            label={status}
            size="sm"
          />
        </Stack>
        <span className="mrd-secondary mrd-clamp-2">{title}</span>
        <Stack direction="row" gap={3} align="center">
          {currentStep && <span className="mrd-caption mrd-truncate">{currentStep}</span>}
          <div className="mrd-spacer" />
          {elapsedMs != null && <span className="mrd-caption mrd-numeric">{formatMs(elapsedMs)}</span>}
        </Stack>
        {model && <span className="mrd-caption mrd-truncate mrd-code">{model}</span>}
        <Stack direction="row" gap={2}>
          {onOpen && (
            <Button size="sm" variant="tertiary" onClick={onOpen}>
              Open
            </Button>
          )}
          <div className="mrd-spacer" />
          {onCancel && (
            <Button size="sm" variant="tertiary" onClick={onCancel}>
              Stop
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

export interface GenerationCardProps {
  job: GenerationJob;
  onCancel?: () => void;
  onReuse?: () => void;
  className?: string;
}

export function GenerationCard({ job, onCancel, onReuse, className }: GenerationCardProps): React.JSX.Element {
  const asset = job.assets[0];
  const pending = job.status === 'queued' || job.status === 'running';

  return (
    <Card className={cx('mrd-gencard', className)}>
      <Stack direction="column" gap={2}>
        <div className="mrd-gencard__media">
          {pending ? (
            <Skeleton variant="block" />
          ) : job.status === 'failed' ? (
            <div className="mrd-gencard__failed">
              <IconClose />
              <span className="mrd-caption">{job.error ?? 'Generation failed'}</span>
            </div>
          ) : asset && job.modality === 'video' ? (
            <video src={asset.url} controls preload="metadata" className="mrd-gencard__asset" />
          ) : asset && job.modality === 'speech' ? (
            <audio src={asset.url} controls className="mrd-gencard__audio" />
          ) : asset ? (
            <img src={asset.url} alt={job.prompt} loading="lazy" className="mrd-gencard__asset" />
          ) : (
            <div className="mrd-gencard__failed">
              <span className="mrd-caption">No asset returned</span>
            </div>
          )}
        </div>

        <p className="mrd-secondary mrd-clamp-2">{job.prompt}</p>

        <Stack direction="row" gap={2} align="center" wrap>
          <StatusChip
            status={job.status === 'completed' ? 'ready' : pending ? 'busy' : 'degraded'}
            label={job.status}
            size="sm"
          />
          {job.modelId && <span className="mrd-caption mrd-truncate">{job.modelId}</span>}
          <div className="mrd-spacer" />
          {typeof job.params.seed === 'number' && <span className="mrd-caption mrd-numeric">seed {job.params.seed}</span>}
        </Stack>

        <Stack direction="row" gap={2}>
          {onReuse && (
            <Button size="sm" variant="tertiary" icon={<IconSparkle />} onClick={onReuse}>
              Reuse prompt
            </Button>
          )}
          <div className="mrd-spacer" />
          {asset && !pending && (
            <a className="mrd-gencard__download" href={asset.url} download>
              <IconDownload /> Download
            </a>
          )}
          {pending && onCancel && (
            <Button size="sm" variant="tertiary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Routing explanation                                                */
/* ------------------------------------------------------------------ */

/**
 * "Why this model?"
 *
 * The transparency surface. It shows the summary, the criteria that were met,
 * the runners-up with their scores, and — importantly — what was ruled out and
 * by which rule. A router that cannot explain a rejection is one nobody can
 * debug.
 */
export function RoutingExplanation({ reason, className }: { reason: RoutingReason; className?: string }): React.JSX.Element {
  const [showRejected, setShowRejected] = useState(false);

  return (
    <div className={cx('mrd-routing', className)}>
      <p className="mrd-routing__summary">{reason.summary}</p>

      <ul className="mrd-routing__criteria">
        {reason.criteria.map((c, i) => (
          <li key={`${c.label}-${i}`} className={cx('mrd-routing__criterion', !c.met && 'mrd-routing__criterion--unmet')}>
            <span className="mrd-routing__glyph" aria-hidden="true">
              {c.met ? '✓' : '·'}
            </span>
            <span>
              {c.label}
              {c.detail && <span className="mrd-caption"> — {c.detail}</span>}
            </span>
            <span className="mrd-sr-only">{c.met ? 'met' : 'not met'}</span>
          </li>
        ))}
      </ul>

      {reason.considered.length > 1 && (
        <div className="mrd-routing__section">
          <div className="mrd-panel-title">Also considered</div>
          <ul className="mrd-routing__considered">
            {reason.considered.slice(1, 5).map((c) => (
              <li key={c.modelId}>
                <span className="mrd-truncate mrd-code">{c.modelId}</span>
                <span className="mrd-caption mrd-numeric">{c.score.toFixed(3)}</span>
                {c.free ? <span className="mrd-caption">free</span> : <span className="mrd-caption mrd-numeric">${c.estimatedCost.toFixed(4)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reason.rejected.length > 0 && (
        <div className="mrd-routing__section">
          <button className="mrd-routing__toggle mrd-focus-ring" aria-expanded={showRejected} onClick={() => setShowRejected((v) => !v)}>
            {showRejected ? 'Hide' : 'Show'} {reason.rejected.length} ruled out
          </button>
          {showRejected && (
            <ul className="mrd-routing__rejected">
              {reason.rejected.map((r, i) => (
                <li key={`${r.modelId}-${i}`}>
                  <span className="mrd-truncate mrd-code">{r.modelId}</span>
                  <span className="mrd-caption">{r.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mrd-caption">
        Mode: {reason.requestedMode ?? reason.mode}
        {reason.requestedMode && reason.requestedMode !== reason.mode ? ` (applied as ${reason.mode})` : ''}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pickers                                                            */
/* ------------------------------------------------------------------ */

interface PickerItem {
  id: string;
  primary: string;
  secondary?: string;
  trailing?: ReactNode;
}

function Picker({
  items,
  onSelect,
  placeholder,
  emptyLabel,
  className,
}: {
  items: PickerItem[];
  onSelect: (id: string) => void;
  placeholder: string;
  emptyLabel: string;
  className?: string;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 60);
    return items.filter((i) => `${i.primary} ${i.secondary ?? ''} ${i.id}`.toLowerCase().includes(q)).slice(0, 60);
  }, [items, query]);

  return (
    <div className={cx('mrd-picker', className)}>
      <SearchField
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onClear={() => setQuery('')}
        placeholder={placeholder}
        aria-label={placeholder}
        size="sm"
      />
      <div className="mrd-picker__list mrd-scroll">
        {filtered.length === 0 ? (
          <EmptyState size="sm" title={emptyLabel} />
        ) : (
          <List selectable>
            {filtered.map((i) => (
              <ListRow key={i.id} value={i.id} secondary={i.secondary} trailing={i.trailing} onClick={() => onSelect(i.id)}>
                {i.primary}
              </ListRow>
            ))}
          </List>
        )}
      </div>
    </div>
  );
}

export function ModelPicker({
  models,
  onSelect,
  placeholder = 'Search models',
  className,
}: {
  models: { id: string; displayName: string; providerId: string; free?: boolean }[];
  onSelect: (id: string) => void;
  placeholder?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Picker
      className={className}
      placeholder={placeholder}
      emptyLabel="No models match"
      onSelect={onSelect}
      items={models.map((m) => ({
        id: m.id,
        primary: m.displayName,
        secondary: m.providerId,
        trailing: m.free ? <Badge variant="success">free</Badge> : undefined,
      }))}
    />
  );
}

export function ProviderPicker({
  providers,
  onSelect,
  className,
}: {
  providers: { id: string; name: string; supportState?: string }[];
  onSelect: (id: string) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <Picker
      className={className}
      placeholder="Search providers"
      emptyLabel="No providers match"
      onSelect={onSelect}
      items={providers.map((p) => ({ id: p.id, primary: p.name, secondary: p.supportState }))}
    />
  );
}

export function PoolPicker({
  pools,
  onSelect,
  className,
}: {
  pools: { id: string; name: string; strategy: string }[];
  onSelect: (id: string) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <Picker
      className={className}
      placeholder="Search pools"
      emptyLabel="No pools match"
      onSelect={onSelect}
      items={pools.map((p) => ({ id: p.id, primary: p.name, secondary: p.strategy }))}
    />
  );
}

export interface ModePickerProps {
  value: string;
  onChange: (mode: string) => void;
  modes: { value: string; description: string }[];
  advanced?: { value: string; description: string }[];
  className?: string;
}

/**
 * The routing-mode control.
 *
 * Six plain-language modes are presented; the explicit policy modes sit behind
 * "Advanced". Presenting fifteen equal choices would make the common case
 * harder without making the rare one easier.
 */
export function ModePicker({ value, onChange, modes, advanced = [], className }: ModePickerProps): React.JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(() => !modes.some((m) => m.value === value));
  const active = [...modes, ...advanced].find((m) => m.value === value);

  return (
    <div className={cx('mrd-modepicker', className)}>
      {showAdvanced ? (
        <select
          className="mrd-modepicker__select mrd-focus-ring"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          aria-label="Routing mode"
        >
          {[...modes, ...advanced].map((m) => (
            <option key={m.value} value={m.value}>
              {m.value}
            </option>
          ))}
        </select>
      ) : (
        <SegmentedControl
          size="sm"
          value={value}
          onChange={onChange}
          options={modes.map((m) => ({ value: m.value, label: m.value }))}
        />
      )}
      {advanced.length > 0 && (
        <button className="mrd-modepicker__toggle mrd-focus-ring" onClick={() => setShowAdvanced((v) => !v)} aria-pressed={showAdvanced}>
          {showAdvanced ? 'Simple' : 'Advanced'}
        </button>
      )}
      {active && <span className="mrd-sr-only">{active.description}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
