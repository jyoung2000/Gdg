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
  type HTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefCallback,
  type RefObject,
} from 'react';
import type { StepStatus } from '@meridian/shared';
import { IconButton } from '../primitives/Button.js';
import { cx } from '../primitives/util.js';

/* ------------------------------------------------------------------ */

/** Glyphs are sized by their container, so they carry no dimensions of their own. */
function CheckGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.4 6.4 11.3 12.5 5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function DashGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4.4 8h7.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function ChevronGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M6.25 4 10.25 8l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M4.5 9.6 8 6.1l3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <rect x="6.1" y="2.1" width="7.8" height="9.8" rx="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 13.9H4.6A2.5 2.5 0 0 1 2.1 11.4V5.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */

/** Marks the elements a roving-tabindex group navigates between. */
const ROW_SELECTOR = '[data-mrd-row]';

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as { current: T | null }).current = node;
}

/** Keeps a local ref for DOM queries alongside the one the consumer passed. */
function useMergedRef<T>(external: Ref<T> | undefined, local: RefObject<T | null>): RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      local.current = node;
      assignRef(external, node);
    },
    [external, local],
  );
}

function rovingRows(container: HTMLElement | null): HTMLElement[] {
  return container ? Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];
}

/**
 * Arrow / Home / End movement inside a roving-tabindex group.
 *
 * Movement clamps at the ends instead of wrapping: a list that jumps from the
 * last row back to the first hides the fact that you reached the bottom. Keys
 * pressed while focus sits on a control *inside* a row are left alone, so a
 * trailing menu button keeps its own keyboard behaviour. Returns whether the
 * key was consumed, so the caller preventDefaults only what it handled.
 */
function moveRoving(container: HTMLElement | null, key: string, from: EventTarget | null): boolean {
  const current = from instanceof HTMLElement && from.matches(ROW_SELECTOR) ? from : null;
  if (!current) return false;
  const rows = rovingRows(container);
  const index = rows.indexOf(current);
  if (index < 0) return false;

  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = Math.min(index + 1, rows.length - 1);
      break;
    case 'ArrowUp':
      next = Math.max(index - 1, 0);
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = rows.length - 1;
      break;
    default:
      return false;
  }

  const target = rows[next];
  if (!target || target === current) return true;
  target.focus();
  return true;
}

/**
 * Picks which row owns the group's single tab stop.
 *
 * The rows are children rather than data, so only the DOM knows their order and
 * which one is selected. The tab stop it already had wins whenever that row
 * survived the render — otherwise focus would silently jump back to the top of
 * the list every time a row above it appeared or disappeared.
 */
function useRovingTabStop(container: RefObject<HTMLElement | null>): [string | null, (key: string) => void] {
  const [tabStop, setTabStop] = useState<string | null>(null);

  useLayoutEffect(() => {
    const rows = rovingRows(container.current);
    const keys = rows.map((row) => row.dataset.rowKey ?? '');
    setTabStop((prev) => {
      if (prev !== null && keys.includes(prev)) return prev;
      const selected = rows.find((row) => row.getAttribute('aria-selected') === 'true');
      return selected?.dataset.rowKey ?? keys[0] ?? null;
    });
  });

  return [tabStop, setTabStop];
}

/** Moves the tab stop to whatever row focus landed on, however it got there. */
function tabStopFromFocus(target: EventTarget | null, setTabStop: (key: string) => void): void {
  const row = target instanceof HTMLElement ? target.closest<HTMLElement>(ROW_SELECTOR) : null;
  if (row?.dataset.rowKey) setTabStop(row.dataset.rowKey);
}

/* ------------------------------------------------------------------ */

export type ListSize = 'sm' | 'md' | 'lg';

interface ListContextValue {
  selectable: boolean;
  selectedValue: string | null;
  select: ((value: string) => void) | undefined;
  tabStop: string | null;
}

const ListContext = createContext<ListContextValue | null>(null);

function useListContext(component: string): ListContextValue {
  const context = useContext(ListContext);
  if (!context) throw new Error(`<${component}> must be rendered inside <List>.`);
  return context;
}

export interface ListProps extends Omit<HTMLAttributes<HTMLUListElement>, 'onSelect'> {
  /** Turns the list into a single-select listbox. */
  selectable?: boolean;
  value?: string | null;
  onSelect?: (value: string) => void;
  size?: ListSize;
  /** A listbox with no accessible name announces as an unlabelled group. */
  label?: string;
  labelledBy?: string;
}

/**
 * The dense list: one line per row, navigated with the arrow keys.
 *
 * The whole list is a single tab stop. Tab moves past it, arrows move within
 * it, and Enter or Space activates — the behaviour of a native list, which is
 * what a keyboard user reaching a sidebar or a result list expects. Rows are
 * children rather than a data prop because the trailing slot is where consumers
 * put arbitrary controls.
 */
export const List = forwardRef<HTMLUListElement, ListProps>(function List(
  { selectable = false, value = null, onSelect, size = 'md', label, labelledBy, className, children, onKeyDown, onFocus, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLUListElement>(null);
  const setRefs = useMergedRef(ref, innerRef);
  const [tabStop, setTabStop] = useRovingTabStop(innerRef);

  return (
    <ul
      ref={setRefs}
      // The explicit list role is not redundant: Safari drops list semantics
      // from a ul whose list-style is none, which the base reset applies to
      // every list in the product.
      role={selectable ? 'listbox' : 'list'}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cx('mrd-list', `mrd-list--${size}`, className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (moveRoving(innerRef.current, event.key, event.target)) event.preventDefault();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        tabStopFromFocus(event.target, setTabStop);
      }}
      {...rest}
    >
      <ListContext.Provider value={{ selectable, selectedValue: value, select: onSelect, tabStop }}>{children}</ListContext.Provider>
    </ul>
  );
});

export interface ListRowProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'onSelect' | 'value'> {
  /** Identity for selection and for the tab stop. Generated when the row has none. */
  value?: string;
  icon?: ReactNode;
  /** Sits after the primary text on the same line — a row is one line tall. */
  secondary?: ReactNode;
  /** Trailing controls, metrics or status. */
  trailing?: ReactNode;
  /** Overrides the selection the list derives from `value`. */
  selected?: boolean;
  disabled?: boolean;
  /** Makes a row of a non-selectable list activatable. */
  onActivate?: (value: string) => void;
}

export const ListRow = forwardRef<HTMLLIElement, ListRowProps>(function ListRow(
  { value, icon, secondary, trailing, selected, disabled = false, onActivate, className, children, onClick, onKeyDown, ...rest },
  ref,
) {
  const context = useListContext('ListRow');
  const generatedId = useId();
  const rowKey = value ?? generatedId;
  const isSelected = selected ?? (context.selectable ? context.selectedValue === rowKey : false);

  const activate = (): void => {
    if (disabled) return;
    if (context.selectable) context.select?.(rowKey);
    onActivate?.(rowKey);
  };

  const body = (
    <>
      {icon ? (
        <span className="mrd-list__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="mrd-list__text">
        <span className="mrd-list__primary mrd-truncate">{children}</span>
        {secondary ? <span className="mrd-list__secondary mrd-truncate">{secondary}</span> : null}
      </span>
      {trailing ? <span className="mrd-list__trailing">{trailing}</span> : null}
    </>
  );

  const rowClass = cx('mrd-list__row', 'mrd-focus-ring', className);

  // Disabled rows stay in the roving order and are marked with aria-disabled
  // rather than removed: hiding a row from the keyboard hides that it exists,
  // which is worse than landing on something that cannot be acted on.
  if (context.selectable) {
    return (
      <li
        ref={ref}
        role="option"
        aria-selected={isSelected}
        aria-disabled={disabled || undefined}
        data-mrd-row=""
        data-row-key={rowKey}
        data-selected={isSelected || undefined}
        data-disabled={disabled || undefined}
        tabIndex={context.tabStop === rowKey ? 0 : -1}
        className={rowClass}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) activate();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          // An li is not a button, so it gets no free activation from the browser.
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        }}
        {...rest}
      >
        {body}
      </li>
    );
  }

  if (onActivate) {
    // A listitem is not an interactive role, so the click target is a real
    // button inside it rather than a tabindex bolted onto the li.
    return (
      <li ref={ref} className="mrd-list__item" data-selected={isSelected || undefined} onClick={onClick} onKeyDown={onKeyDown} {...rest}>
        <button
          type="button"
          data-mrd-row=""
          data-row-key={rowKey}
          data-selected={isSelected || undefined}
          data-disabled={disabled || undefined}
          aria-disabled={disabled || undefined}
          tabIndex={context.tabStop === rowKey ? 0 : -1}
          className={rowClass}
          onClick={() => activate()}
        >
          {body}
        </button>
      </li>
    );
  }

  return (
    <li
      ref={ref}
      className={cx('mrd-list__row', className)}
      data-selected={isSelected || undefined}
      data-disabled={disabled || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {body}
    </li>
  );
});

/* ------------------------------------------------------------------ */

export type TableAlign = 'start' | 'end';
export type TableSortDirection = 'asc' | 'desc';

export interface TableSort {
  key: string;
  direction: TableSortDirection;
}

export interface TableColumn<T> {
  key: string;
  header: string;
  /** Any CSS length; applied through a <col> so it survives horizontal scroll. */
  width?: string;
  align?: TableAlign;
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

export interface TableProps<T> extends HTMLAttributes<HTMLDivElement> {
  columns: TableColumn<T>[];
  rows: T[];
  /** Stable identity per row, used for React keys, selection and the tab stop. */
  rowKey: (row: T, index: number) => string;
  /** The table's accessible name. Rendered as a caption for assistive tech only. */
  caption?: string;
  labelledBy?: string;
  stickyHeader?: boolean;
  sort?: TableSort | null;
  onSortChange?: (sort: TableSort) => void;
  selectedKey?: string | null;
  /** Providing this makes rows selectable, focusable and arrow-navigable. */
  onSelectRow?: (row: T, key: string) => void;
  loading?: boolean;
  skeletonRows?: number;
  /** Shown in place of rows when there are none and nothing is loading. */
  empty?: ReactNode;
  loadingLabel?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * The generic table.
 *
 * It owns its horizontal overflow so a wide result set scrolls inside its own
 * box rather than dragging the whole workstation sideways. That same box is the
 * scrollport the sticky header sticks to, which means the header only stays put
 * when the consumer gives this element a bounded height.
 *
 * Separators are hairlines, never zebra stripes: banding competes with the
 * selection fill and turns a dense table into a texture.
 *
 * Selectable rows stay a table with aria-selected and a roving tab stop rather
 * than becoming role="grid": a grid promises cell-by-cell arrow navigation,
 * and a promise the component does not keep is worse than the plain table
 * semantics a screen reader already navigates well.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  labelledBy,
  stickyHeader = true,
  sort = null,
  onSortChange,
  selectedKey = null,
  onSelectRow,
  loading = false,
  skeletonRows = 5,
  empty,
  loadingLabel = 'Loading',
  className,
  onKeyDown,
  onFocus,
  ref,
  ...rest
}: TableProps<T>): React.JSX.Element {
  const innerRef = useRef<HTMLDivElement>(null);
  const setRefs = useMergedRef(ref, innerRef);
  const [tabStop, setTabStop] = useRovingTabStop(innerRef);
  const selectable = onSelectRow != null;

  const toggleSort = (column: TableColumn<T>): void => {
    if (sort && sort.key === column.key) {
      onSortChange?.({ key: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
      return;
    }
    // Numbers are most useful largest-first, text A–Z; that is the first click.
    onSortChange?.({ key: column.key, direction: column.align === 'end' ? 'desc' : 'asc' });
  };

  return (
    <div
      ref={setRefs}
      className={cx('mrd-table', stickyHeader && 'mrd-table--sticky', className)}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (moveRoving(innerRef.current, event.key, event.target)) event.preventDefault();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        tabStopFromFocus(event.target, setTabStop);
      }}
      {...rest}
    >
      {/* aria-busy alone is silent; a live region says the wait is deliberate. */}
      <span role="status" className="mrd-sr-only">
        {loading ? loadingLabel : ''}
      </span>
      <table className="mrd-table__grid" aria-labelledby={labelledBy}>
        {caption ? <caption className="mrd-sr-only">{caption}</caption> : null}
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead className="mrd-table__head">
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const sortable = Boolean(column.sortable) && onSortChange != null;
              return (
                <th
                  key={column.key}
                  scope="col"
                  // aria-sort belongs on the header cell, not on the button, and
                  // must be absent entirely on columns that cannot be sorted.
                  aria-sort={sortable ? (active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  className={cx('mrd-table__th', column.align === 'end' && 'mrd-table__cell--end', column.align === 'end' && 'mrd-numeric')}
                >
                  {sortable ? (
                    <button type="button" className="mrd-table__sort mrd-focus-ring" onClick={() => toggleSort(column)}>
                      <span className="mrd-truncate">{column.header}</span>
                      <span className="mrd-table__sort-glyph" aria-hidden="true">
                        <ArrowGlyph />
                      </span>
                    </button>
                  ) : (
                    <span className="mrd-truncate">{column.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="mrd-table__body">
          {loading
            ? Array.from({ length: skeletonRows }, (_unused, index) => (
                <tr key={`skeleton-${index}`} className="mrd-table__row mrd-table__row--skeleton" aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.key} className="mrd-table__td">
                      <span className="mrd-table__skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            : null}

          {!loading && rows.length === 0 ? (
            <tr className="mrd-table__row">
              <td className="mrd-table__empty" colSpan={columns.length}>
                {empty ?? 'No rows'}
              </td>
            </tr>
          ) : null}

          {!loading
            ? rows.map((row, index) => {
                const key = rowKey(row, index);
                const isSelected = selectable && key === selectedKey;
                return (
                  <tr
                    key={key}
                    className="mrd-table__row"
                    data-mrd-row={selectable ? '' : undefined}
                    data-row-key={key}
                    data-selected={isSelected || undefined}
                    aria-selected={selectable ? isSelected : undefined}
                    tabIndex={selectable ? (tabStop === key ? 0 : -1) : undefined}
                    onClick={selectable ? () => onSelectRow?.(row, key) : undefined}
                    onKeyDown={
                      selectable
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onSelectRow?.(row, key);
                            }
                          }
                        : undefined
                    }
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        // End-aligned columns are numbers by convention here, so
                        // they get tabular figures: a live cost or latency column
                        // must not reflow as its digits change.
                        className={cx('mrd-table__td', column.align === 'end' && 'mrd-table__cell--end', column.align === 'end' && 'mrd-numeric')}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            : null}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export type TimelineStatus = StepStatus;

/** Spoken status, so the glyph is never the only carrier of the state. */
const STEP_STATUS_LABELS: Record<TimelineStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
};

function StepGlyph({ status }: { status: TimelineStatus }): React.JSX.Element | null {
  switch (status) {
    case 'completed':
      return <CheckGlyph />;
    case 'failed':
      return <CrossGlyph />;
    case 'skipped':
      return <DashGlyph />;
    case 'running':
      return <span className="mrd-timeline__dot" />;
    default:
      // Pending is the empty ring the indicator draws with its own border.
      return null;
  }
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  label?: string;
  labelledBy?: string;
}

/**
 * The agent task timeline: an ordered list, because the order is the meaning.
 */
export const Timeline = forwardRef<HTMLOListElement, TimelineProps>(function Timeline({ label, labelledBy, className, children, ...rest }, ref) {
  return (
    <ol ref={ref} className={cx('mrd-timeline', className)} aria-label={label} aria-labelledby={labelledBy} {...rest}>
      {children}
    </ol>
  );
});

export interface TimelineStepProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'onToggle'> {
  status: TimelineStatus;
  label: ReactNode;
  /** Second line under the label, e.g. the model that ran the step. */
  meta?: ReactNode;
  /** Right-hand duration, e.g. "1.4s". */
  duration?: ReactNode;
  /** Revealed on expand. Without it the step is not expandable. */
  details?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

/**
 * One step of the timeline.
 *
 * Every state has its own glyph — an empty ring, a live dot, a check, a cross,
 * a dash — so the run reads correctly in greyscale and to anyone who cannot
 * separate the status colours. The connector below a step is accent-filled once
 * the step is behind us, which is what makes the rail read as progress rather
 * than decoration.
 */
export const TimelineStep = forwardRef<HTMLLIElement, TimelineStepProps>(function TimelineStep(
  { status, label, meta, duration, details, expanded, defaultExpanded = false, onExpandedChange, className, ...rest },
  ref,
) {
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const detailsId = useId();
  const expandable = details != null;
  const open = expandable && (expanded ?? uncontrolled);

  const toggle = (): void => {
    const next = !open;
    if (expanded === undefined) setUncontrolled(next);
    onExpandedChange?.(next);
  };

  const header = (
    <>
      <span className="mrd-timeline__indicator" data-status={status} aria-hidden="true">
        <StepGlyph status={status} />
      </span>
      <span className="mrd-timeline__text">
        <span className="mrd-timeline__label mrd-truncate">{label}</span>
        {meta ? <span className="mrd-timeline__meta mrd-truncate">{meta}</span> : null}
      </span>
      <span className="mrd-sr-only">{STEP_STATUS_LABELS[status]}</span>
      {duration ? <span className="mrd-timeline__duration mrd-numeric">{duration}</span> : null}
      {expandable ? (
        <span className="mrd-timeline__chevron" aria-hidden="true">
          <ChevronGlyph />
        </span>
      ) : null}
    </>
  );

  return (
    <li ref={ref} className={cx('mrd-timeline__step', className)} data-status={status} data-open={open || undefined} {...rest}>
      <span className="mrd-timeline__rail" aria-hidden="true" />
      {expandable ? (
        <button type="button" className="mrd-timeline__header mrd-focus-ring" aria-expanded={open} aria-controls={detailsId} onClick={toggle}>
          {header}
        </button>
      ) : (
        <span className="mrd-timeline__header">{header}</span>
      )}
      {/* Always rendered: aria-controls must resolve to a real node even while
          the panel is closed, or the relationship is broken. */}
      {expandable ? (
        <div id={detailsId} className="mrd-timeline__details" hidden={!open}>
          {details}
        </div>
      ) : null}
    </li>
  );
});

/* ------------------------------------------------------------------ */

/** Long enough to read the confirmation, short enough not to linger. */
const COPIED_FEEDBACK_MS = 1400;

function CopyValueButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => window.clearTimeout(timer.current ?? undefined), []);

  const copy = async (): Promise<void> => {
    // The clipboard API is unavailable outside a secure context and rejects
    // when the permission is denied; staying on the idle label means nothing
    // false is announced.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current ?? undefined);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <span className="mrd-kv__copy" data-copied={copied || undefined}>
      <IconButton
        size="sm"
        variant="tertiary"
        label={copied ? `${label} copied` : `Copy ${label}`}
        icon={copied ? <CheckGlyph /> : <CopyGlyph />}
        onClick={() => void copy()}
      />
      {/* The swapped glyph is invisible to a screen reader, and a renamed button
          is not announced on its own, so the confirmation gets its own region. */}
      <span role="status" className="mrd-sr-only">
        {copied ? `${label} copied` : ''}
      </span>
    </span>
  );
}

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** Exact text to place on the clipboard. Presence adds the copy affordance. */
  copy?: string;
  /** Tabular figures, for anything that will be compared down a column. */
  numeric?: boolean;
  /** Lets a long value wrap onto more lines instead of truncating. */
  wrap?: boolean;
}

export interface KeyValueProps extends HTMLAttributes<HTMLDListElement> {
  items: KeyValueItem[];
  /** Stacked puts the label above the value, for narrow inspectors. */
  layout?: 'row' | 'stacked';
  align?: 'start' | 'end';
}

/**
 * The metadata panel's definition list.
 *
 * Values sit hard against the right edge so a column of ids, costs and
 * timestamps lines up on its last character, which is where the eye compares
 * them. The copy button only appears on hover or focus — a panel of twenty
 * rows with twenty visible buttons is a wall of chrome.
 */
export const KeyValue = forwardRef<HTMLDListElement, KeyValueProps>(function KeyValue({ items, layout = 'row', align = 'end', className, ...rest }, ref) {
  return (
    <dl ref={ref} className={cx('mrd-kv', `mrd-kv--${layout}`, `mrd-kv--${align}`, className)} {...rest}>
      {items.map((item, index) => (
        <div className="mrd-kv__pair" key={`${item.label}-${index}`}>
          <dt className="mrd-kv__label mrd-truncate">{item.label}</dt>
          <dd className="mrd-kv__value">
            <span
              className={cx('mrd-kv__text', item.numeric && 'mrd-numeric', !item.wrap && 'mrd-truncate')}
              title={typeof item.value === 'string' ? item.value : undefined}
            >
              {item.value}
            </span>
            {item.copy ? <CopyValueButton text={item.copy} label={item.label} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
});
