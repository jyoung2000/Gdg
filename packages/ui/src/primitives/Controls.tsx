import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cx, formatShortcut } from './util.js';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Percentage of the way from min to max, guarding a zero-width range. */
function ratio(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

function fillVar(fraction: number): CSSProperties {
  return { '--mrd-fill': `${(fraction * 100).toFixed(2)}%` } as CSSProperties;
}

/* ------------------------------------------------------------------ */

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  /** Leading glyph, sized by the segment. Pass an icon component, not a box. */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  /** A radiogroup with no accessible name announces as an unlabelled group. */
  label?: string;
  labelledBy?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * The joined selector: one control holding two to five mutually exclusive
 * choices, with a raised pill that slides to the selection.
 *
 * It is a radiogroup rather than a row of buttons because that is what it is —
 * arrow keys move the selection, and only the checked segment is in the tab
 * order, so a keyboard user tabs past the whole control in one stop.
 *
 * The pill is a single absolutely-positioned element driven by measured
 * geometry; animating a background on each segment instead would cross-fade
 * rather than travel, which loses the sense that one thing moved.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  label,
  labelledBy,
  className,
  ref,
  ...rest
}: SegmentedControlProps<T>): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const [animate, setAnimate] = useState(false);

  const selectedIndex = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = segmentRefs.current[selectedIndex];
      if (!el || !trackRef.current) {
        setIndicator(null);
        return;
      }
      const x = el.offsetLeft;
      const w = el.offsetWidth;
      // Identity-stable update: the effect re-runs on every render when the
      // caller passes an inline options array, and a fresh object each time
      // would loop.
      setIndicator((prev) => (prev && prev.x === x && prev.w === w ? prev : { x, w }));
    };
    measure();

    // Labels reflow when the container resizes or a webfont lands, and the
    // pill has to follow rather than sit next to the segment it names.
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [selectedIndex, options]);

  // The pill must appear at its resting position rather than sliding in from
  // the left edge on mount, so travel is enabled one frame after first paint.
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const move = useCallback(
    (from: number, direction: 1 | -1) => {
      const n = options.length;
      for (let step = 1; step <= n; step++) {
        const next = (((from + direction * step) % n) + n) % n;
        const option = options[next];
        if (option.disabled) continue;
        segmentRefs.current[next]?.focus();
        onChange(option.value);
        return;
      }
    },
    [options, onChange],
  );

  const edge = useCallback(
    (direction: 1 | -1) => {
      const ordered = direction === 1 ? options : [...options].reverse();
      const option = ordered.find((o) => !o.disabled);
      if (!option) return;
      const index = options.indexOf(option);
      segmentRefs.current[index]?.focus();
      onChange(option.value);
    },
    [options, onChange],
  );

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cx('mrd-segmented', `mrd-segmented--${size}`, fullWidth && 'mrd-segmented--full', className)}
      {...rest}
    >
      <div className="mrd-segmented__track" ref={trackRef}>
        {indicator ? (
          <span
            className="mrd-segmented__indicator"
            data-animate={animate || undefined}
            style={{ '--mrd-seg-x': `${indicator.x}px`, '--mrd-seg-w': `${indicator.w}px` } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              // Roving tabindex: the group is one tab stop, arrows move inside it.
              tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
              disabled={option.disabled}
              data-selected={selected || undefined}
              ref={(node) => {
                segmentRefs.current[index] = node;
              }}
              className={cx('mrd-segmented__option', 'mrd-focus-ring')}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case 'ArrowRight':
                  case 'ArrowDown':
                    event.preventDefault();
                    move(index, 1);
                    break;
                  case 'ArrowLeft':
                  case 'ArrowUp':
                    event.preventDefault();
                    move(index, -1);
                    break;
                  case 'Home':
                    event.preventDefault();
                    edge(1);
                    break;
                  case 'End':
                    event.preventDefault();
                    edge(-1);
                    break;
                  default:
                    break;
                }
              }}
            >
              {option.icon ? (
                <span className="mrd-segmented__icon" aria-hidden="true">
                  {option.icon}
                </span>
              ) : null}
              <span className="mrd-segmented__label">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export type TabsVariant = 'underline' | 'pill';
export type TabsOrientation = 'horizontal' | 'vertical';

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  baseId: string;
  variant: TabsVariant;
  orientation: TabsOrientation;
  activation: 'automatic' | 'manual';
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> must be rendered inside <Tabs>.`);
  return context;
}

/** Tab values are arbitrary strings; ids derived from them must stay id-safe. */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-');
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /** Controlled selection. Omit and pass defaultValue to let Tabs own it. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  variant?: TabsVariant;
  orientation?: TabsOrientation;
  /** Manual activation moves focus without switching panels; use it when a panel is expensive to render. */
  activation?: 'automatic' | 'manual';
  children: ReactNode;
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, defaultValue, onChange, variant = 'underline', orientation = 'horizontal', activation = 'automatic', className, children, ...rest },
  ref,
) {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '');
  const current = value ?? uncontrolled;

  const select = useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolled(next);
      onChange?.(next);
    },
    [value, onChange],
  );

  return (
    <TabsContext.Provider value={{ value: current, select, baseId, variant, orientation, activation }}>
      <div
        ref={ref}
        className={cx('mrd-tabs', `mrd-tabs--${variant}`, className)}
        data-orientation={orientation}
        {...rest}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
});

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
  labelledBy?: string;
}

export const TabList = forwardRef<HTMLDivElement, TabListProps>(function TabList(
  { label, labelledBy, className, children, onKeyDown, ...rest },
  ref,
) {
  const { variant, orientation, activation, select } = useTabsContext('TabList');
  const horizontal = orientation === 'horizontal';

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-orientation={orientation}
      className={cx('mrd-tablist', `mrd-tablist--${variant}`, className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;

        const next = horizontal ? 'ArrowRight' : 'ArrowDown';
        const prev = horizontal ? 'ArrowLeft' : 'ArrowUp';
        if (event.key !== next && event.key !== prev && event.key !== 'Home' && event.key !== 'End') return;

        // Only the keys for this orientation are claimed, so a vertical list
        // inside a scrolling pane still scrolls with Left/Right.
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
        if (tabs.length === 0) return;
        const from = tabs.indexOf(document.activeElement as HTMLButtonElement);

        let target: HTMLButtonElement;
        if (event.key === 'Home') target = tabs[0];
        else if (event.key === 'End') target = tabs[tabs.length - 1];
        else {
          const direction = event.key === next ? 1 : -1;
          const start = from === -1 ? 0 : from;
          target = tabs[(((start + direction) % tabs.length) + tabs.length) % tabs.length];
        }

        event.preventDefault();
        target.focus();
        if (activation === 'automatic' && target.dataset.value) select(target.dataset.value);
      }}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'type'> {
  value: string;
  icon?: ReactNode;
  /** Trailing count, e.g. how many rows a filter tab would show. */
  count?: ReactNode;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { value, icon, count, className, children, onClick, ...rest },
  ref,
) {
  const context = useTabsContext('Tab');
  const selected = context.value === value;

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={`${context.baseId}-tab-${idPart(value)}`}
      aria-selected={selected}
      aria-controls={`${context.baseId}-panel-${idPart(value)}`}
      // Roving tabindex: the tablist is a single tab stop.
      tabIndex={selected ? 0 : -1}
      data-value={value}
      data-selected={selected || undefined}
      className={cx('mrd-tab', `mrd-tab--${context.variant}`, 'mrd-focus-ring', className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.select(value);
      }}
      {...rest}
    >
      {icon ? (
        <span className="mrd-tab__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="mrd-tab__label">{children}</span>
      {count !== undefined && count !== null ? <span className="mrd-tab__count mrd-numeric">{count}</span> : null}
    </button>
  );
});

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  /** Defer mounting children until the panel is first shown; it stays mounted after. */
  lazy?: boolean;
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { value, lazy = false, className, children, ...rest },
  ref,
) {
  const context = useTabsContext('TabPanel');
  const active = context.value === value;
  const [mounted, setMounted] = useState(!lazy || active);

  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  return (
    // The element is always rendered, even when empty: aria-controls on the
    // tab must resolve to a real node or the relationship is broken.
    <div
      ref={ref}
      role="tabpanel"
      id={`${context.baseId}-panel-${idPart(value)}`}
      aria-labelledby={`${context.baseId}-tab-${idPart(value)}`}
      hidden={!active}
      // A panel whose content holds no focusable element is unreachable by
      // keyboard unless the panel itself can take focus.
      tabIndex={active ? 0 : -1}
      className={cx('mrd-tabpanel', className)}
      {...rest}
    >
      {mounted ? children : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** A combo in `matchesShortcut` form, e.g. "mod+shift+k". */
  shortcut: string;
  size?: 'sm' | 'md';
  /** Spoken form, when the glyphs alone would not read sensibly. */
  label?: string;
}

/**
 * A keycap for a shortcut hint.
 *
 * `formatShortcut` concatenates modifiers on Apple platforms (⌘K) and joins
 * them elsewhere (Ctrl+K), so the parts are split back out to give each key its
 * own cap where the platform convention has separate keys.
 */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd({ shortcut, size = 'md', label, className, ...rest }, ref) {
  const formatted = formatShortcut(shortcut);
  const caps = formatted.includes('+') ? formatted.split('+') : [formatted];

  return (
    <kbd ref={ref} className={cx('mrd-kbd', `mrd-kbd--${size}`, className)} {...rest}>
      {label ? <span className="mrd-sr-only">{label}</span> : null}
      {caps.map((cap, index) => (
        <span key={`${cap}-${index}`} className="mrd-kbd__cap" aria-hidden={label ? true : undefined}>
          {cap}
        </span>
      ))}
    </kbd>
  );
});

/* ------------------------------------------------------------------ */

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  /** Renders a count, capped at `max`. Overrides children when set. */
  count?: number;
  max?: number;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', size = 'md', count, max = 99, className, children, ...rest },
  ref,
) {
  const capped = count !== undefined && count > max;
  const content = count !== undefined ? `${capped ? max : count}${capped ? '+' : ''}` : children;

  return (
    <span
      ref={ref}
      className={cx('mrd-badge', `mrd-badge--${variant}`, `mrd-badge--${size}`, count !== undefined && 'mrd-numeric', className)}
      {...rest}
    >
      {/* "99+" is a truncation for the eye; the real count is what gets said. */}
      {capped ? (
        <>
          <span aria-hidden="true">{content}</span>
          <span className="mrd-sr-only">{count}</span>
        </>
      ) : (
        content
      )}
    </span>
  );
});

/* ------------------------------------------------------------------ */

export type Status = 'ready' | 'busy' | 'rate_limited' | 'degraded' | 'offline' | 'unknown' | 'healthy' | 'error';

const STATUS_LABELS: Record<Status, string> = {
  ready: 'Ready',
  busy: 'Busy',
  rate_limited: 'Rate limited',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Unknown',
  healthy: 'Healthy',
  error: 'Error',
};

/**
 * A distinct silhouette per status, not a recoloured dot.
 *
 * Roughly a tenth of users cannot separate the success green from the warning
 * amber, and a screenshot pasted into a ticket loses hue entirely — so shape
 * carries the meaning and colour only reinforces it.
 */
function StatusGlyph({ status }: { status: Status }): React.JSX.Element {
  return (
    <svg className="mrd-status-chip__glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {status === 'ready' ? <circle cx="6" cy="6" r="3.5" fill="currentColor" /> : null}
      {status === 'healthy' ? (
        <>
          <circle cx="6" cy="6" r="2" fill="currentColor" />
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </>
      ) : null}
      {status === 'busy' ? (
        <>
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </>
      ) : null}
      {status === 'rate_limited' ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M3.9 6h4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : null}
      {status === 'degraded' ? <path d="M6 1.5 11 10.5H1z" fill="currentColor" /> : null}
      {status === 'offline' ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M3.2 8.8 8.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : null}
      {status === 'unknown' ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" /> : null}
      {status === 'error' ? (
        <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  status: Status;
  /** Visible text. Defaults to the status name; pair it with `hideLabel` for a bare glyph. */
  label?: string;
  size?: 'sm' | 'md';
  hideLabel?: boolean;
}

export const StatusChip = forwardRef<HTMLSpanElement, StatusChipProps>(function StatusChip(
  { status, label, size = 'md', hideLabel = false, className, ...rest },
  ref,
) {
  const statusText = STATUS_LABELS[status];
  const visible = hideLabel ? null : (label ?? statusText);
  // The canonical status is always announced — a chip labelled with a model
  // name would otherwise convey its state through the glyph alone.
  const announced = visible === statusText ? null : statusText;

  return (
    <span
      ref={ref}
      className={cx('mrd-status-chip', `mrd-status-chip--${size}`, hideLabel && 'mrd-status-chip--bare', className)}
      data-status={status}
      {...rest}
    >
      <StatusGlyph status={status} />
      {visible ? <span className="mrd-status-chip__label">{visible}</span> : null}
      {announced ? <span className="mrd-sr-only">{announced}</span> : null}
    </span>
  );
});

/* ------------------------------------------------------------------ */

export type BarTone = 'accent' | 'success' | 'warning' | 'error';

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  /** One of `label` / `labelledBy` is required: a bare bar has no accessible name. */
  label?: string;
  labelledBy?: string;
  /** Spoken value, when a raw number would not mean anything ("3 of 8 steps"). */
  valueText?: string;
  size?: 'sm' | 'md';
  tone?: BarTone;
}

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value = 0, max = 100, indeterminate = false, label, labelledBy, valueText, size = 'md', tone = 'accent', className, ...rest },
  ref,
) {
  const fraction = ratio(value, 0, max);

  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-labelledby={labelledBy}
      // An indeterminate bar omits aria-valuenow entirely; that absence is what
      // tells assistive technology the amount of work is unknown.
      aria-valuenow={indeterminate ? undefined : clamp(value, 0, max)}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuetext={valueText}
      className={cx('mrd-progress', `mrd-progress--${size}`, className)}
      data-tone={tone}
      data-indeterminate={indeterminate || undefined}
      {...rest}
    >
      <span className="mrd-progress__fill" style={indeterminate ? undefined : fillVar(fraction)} />
    </div>
  );
});

/* ------------------------------------------------------------------ */

export interface MeterProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value: number;
  min?: number;
  max?: number;
  /** Marks where the gauge starts warning, e.g. 80% of a spend cap. */
  threshold?: number;
  label: string;
  /** Spoken and, with `showLabel`, displayed value — "$18.40 of $25.00". */
  valueText?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  tone?: BarTone;
}

export const Meter = forwardRef<HTMLDivElement, MeterProps>(function Meter(
  { value, min = 0, max = 100, threshold, label, valueText, showLabel = false, size = 'md', tone, className, ...rest },
  ref,
) {
  const labelId = useId();
  const fraction = ratio(value, min, max);
  const over = threshold !== undefined && value >= threshold;
  const resolvedTone: BarTone = tone ?? (over ? 'warning' : 'accent');

  return (
    <div ref={ref} className={cx('mrd-meter', `mrd-meter--${size}`, className)} {...rest}>
      {showLabel ? (
        <div className="mrd-meter__header">
          <span id={labelId} className="mrd-meter__name">
            {label}
          </span>
          {valueText ? <span className="mrd-meter__value mrd-numeric">{valueText}</span> : null}
        </div>
      ) : null}
      <div
        role="meter"
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? labelId : undefined}
        aria-valuenow={clamp(value, min, max)}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={valueText}
        className="mrd-meter__track"
        data-tone={resolvedTone}
      >
        <span className="mrd-meter__fill" style={fillVar(fraction)} />
        {threshold !== undefined ? (
          <span
            className="mrd-meter__threshold"
            style={{ left: `${(ratio(threshold, min, max) * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */

export type AvatarTint = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'auto';

const AUTO_TINTS = ['accent', 'success', 'warning', 'error', 'neutral'] as const;

/** Stable per-name tint, so the same person keeps the same colour across views. */
function autoTint(seed: string): (typeof AUTO_TINTS)[number] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AUTO_TINTS[hash % AUTO_TINTS.length];
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string;
  src?: string | null;
  /** Defaults to `name`. Set to '' when the name is already in adjacent text. */
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  tint?: AvatarTint;
  /** Replaces initials, e.g. a provider mark. */
  icon?: ReactNode;
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, alt, size = 'md', tint = 'neutral', icon, className, ...rest },
  ref,
) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;
  const initials = name ? initialsOf(name) : '';
  const resolvedTint = tint === 'auto' ? autoTint(name ?? '') : tint;
  const altText = alt ?? name ?? '';

  return (
    <span
      ref={ref}
      className={cx('mrd-avatar', `mrd-avatar--${size}`, `mrd-avatar--${resolvedTint}`, className)}
      // Initials are a picture of a name, not text to be spelled out; without
      // a name there is nothing to announce and the element is decorative.
      role={!showImage && name ? 'img' : undefined}
      aria-label={!showImage && name ? name : undefined}
      aria-hidden={!showImage && !name ? true : undefined}
      {...rest}
    >
      {showImage ? (
        <img className="mrd-avatar__image" src={src ?? undefined} alt={altText} onError={() => setFailed(true)} />
      ) : icon ? (
        <span className="mrd-avatar__icon" aria-hidden="true">
          {icon}
        </span>
      ) : (
        <span className="mrd-avatar__initials" aria-hidden="true">
          {initials}
        </span>
      )}
    </span>
  );
});

/* ------------------------------------------------------------------ */

export type SkeletonVariant = 'text' | 'line' | 'block' | 'circle';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  /** Number of text rows; the last is short, the way a paragraph ends. */
  lines?: number;
  /** Announces the wait. Omit when a labelled region already says it is busy. */
  label?: string;
}

function toLength(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(function Skeleton(
  { variant = 'text', width, height, lines = 1, label, className, style, ...rest },
  ref,
) {
  const box: CSSProperties = { ...style, width: toLength(width), height: toLength(height) };
  // Placeholders are noise to a screen reader unless they are the only thing
  // present, in which case one live message replaces the whole block.
  const semantics = label
    ? ({ role: 'status', 'aria-live': 'polite' as const })
    : ({ 'aria-hidden': true as const });

  if (variant === 'text' && lines > 1) {
    return (
      <span ref={ref} className={cx('mrd-skeleton-group', className)} style={box} {...semantics} {...rest}>
        {label ? <span className="mrd-sr-only">{label}</span> : null}
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} className="mrd-skeleton mrd-skeleton--text" data-last={index === lines - 1 || undefined} />
        ))}
      </span>
    );
  }

  return (
    <span ref={ref} className={cx('mrd-skeleton', `mrd-skeleton--${variant}`, className)} style={box} {...semantics} {...rest}>
      {label ? <span className="mrd-sr-only">{label}</span> : null}
    </span>
  );
});

/* ------------------------------------------------------------------ */

const STAR_PATH = 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

function Star({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg className="mrd-stars__star" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={STAR_PATH} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export interface StarsProps extends HTMLAttributes<HTMLSpanElement> {
  /** Rating on the 0..max scale. Rounded to the nearest half star for display. */
  value: number;
  max?: number;
  /** What is being rated, e.g. "Coding" — becomes "Coding: 4 out of 5". */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
}

export const Stars = forwardRef<HTMLSpanElement, StarsProps>(function Stars(
  { value, max = 5, label, size = 'md', showValue = false, className, ...rest },
  ref,
) {
  const rounded = Math.round(clamp(value, 0, max) * 2) / 2;
  const description = `${label ? `${label}: ` : ''}${rounded} out of ${max}`;

  return (
    <span ref={ref} className={cx('mrd-stars', `mrd-stars--${size}`, className)} role="img" aria-label={description} {...rest}>
      <span className="mrd-stars__rail">
        <span className="mrd-stars__row" aria-hidden="true">
          {Array.from({ length: max }, (_, index) => (
            <Star key={index} filled={false} />
          ))}
        </span>
        {/* Half stars are a clip of the filled row rather than a third glyph:
            one path, and the edge lands exactly on the geometric half. */}
        <span className="mrd-stars__row mrd-stars__row--filled" style={fillVar(rounded / max)} aria-hidden="true">
          {Array.from({ length: max }, (_, index) => (
            <Star key={index} filled />
          ))}
        </span>
      </span>
      {showValue ? (
        <span className="mrd-stars__value mrd-numeric" aria-hidden="true">
          {rounded}
        </span>
      ) : null}
    </span>
  );
});
