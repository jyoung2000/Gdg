import {
  Children,
  Fragment,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cx } from '../primitives/util.js';

/** Not exported: consumers pass the number, and the union keeps them honest. */
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

function headingTag(level: HeadingLevel): HeadingTag {
  return `h${level}` as HeadingTag;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 0 is a flat surface, 4 a modal. Maps straight onto the shadow tokens. */
export type PanelElevation = 0 | 1 | 2 | 3 | 4;

/** The space scale, by index. Nothing off the scale is expressible. */
export type StackGap = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

/* ------------------------------------------------------------------ */

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned controls. Keep it to two or three; this is not a toolbar. */
  actions?: ReactNode;
  /** Set the level that matches the surrounding outline — default is h2. */
  headingLevel?: HeadingLevel;
  titleId?: string;
  /** 'label' switches to the small uppercase style for dense sub-panels. */
  variant?: 'section' | 'label';
}

export const PanelHeader = forwardRef<HTMLDivElement, PanelHeaderProps>(function PanelHeader(
  { title, subtitle, actions, headingLevel = 2, titleId, variant = 'section', className, children, ...rest },
  ref,
) {
  const Heading = headingTag(headingLevel);
  return (
    <div ref={ref} className={cx('mrd-panel-header', `mrd-panel-header--${variant}`, className)} {...rest}>
      <div className="mrd-panel-header__text">
        <Heading id={titleId} className={cx('mrd-panel-header__title', variant === 'label' ? 'mrd-panel-title' : 'mrd-section-title', 'mrd-truncate')}>
          {title}
        </Heading>
        {subtitle ? <p className="mrd-panel-header__subtitle mrd-secondary mrd-truncate">{subtitle}</p> : null}
      </div>
      {children}
      {actions ? <div className="mrd-panel-header__actions">{actions}</div> : null}
    </div>
  );
});

export interface PanelBodyProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  /** Off for bodies that own their own scrolling, such as a virtual list. */
  scroll?: boolean;
}

export const PanelBody = forwardRef<HTMLDivElement, PanelBodyProps>(function PanelBody(
  { padded = true, scroll = true, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('mrd-panel-body', padded && 'mrd-panel-body--padded', scroll && 'mrd-panel-body--scroll', className)} {...rest}>
      {children}
    </div>
  );
});

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  elevation?: PanelElevation;
  headingLevel?: HeadingLevel;
}

/**
 * The level-1 surface: everything that is a region of the workstation sits in
 * one. It is a flex column, so a PanelBody child takes the remaining height and
 * scrolls while the header and footer stay put.
 *
 * Passing `title` renders the header for you and names the region with it — an
 * unnamed region is invisible to anyone navigating by landmark.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { title, subtitle, actions, footer, elevation = 1, headingLevel = 2, className, children, ...rest },
  ref,
) {
  const uid = useId();
  const titleId = `${uid}-title`;
  return (
    <section
      ref={ref}
      className={cx('mrd-panel', `mrd-panel--elevation-${elevation}`, className)}
      aria-labelledby={title ? titleId : undefined}
      {...rest}
    >
      {title ? <PanelHeader title={title} subtitle={subtitle} actions={actions} headingLevel={headingLevel} titleId={titleId} /> : null}
      {children}
      {footer ? <div className="mrd-panel__footer">{footer}</div> : null}
    </section>
  );
});

/* ------------------------------------------------------------------ */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevation?: PanelElevation;
  padded?: boolean;
  /** Renders the selected treatment and exposes it as a pressed state. */
  selected?: boolean;
}

/**
 * A lighter grouping surface than a Panel — a hairline and a small radius,
 * used for the repeated things in a list: a provider, a model, a route.
 *
 * Giving it `onClick` makes it a control: it gains a role, a tab stop, keyboard
 * activation and a hover lift. It is a div with role="button" rather than a
 * native button because cards routinely carry their own buttons and links, and
 * nesting those inside a <button> is invalid and unreachable by keyboard.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { elevation = 0, padded = true, selected, className, children, onClick, onKeyDown, ...rest },
  ref,
) {
  const interactive = onClick != null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    // A key pressed inside a nested control belongs to that control; forwarding
    // it here would activate the card as well.
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      // Space scrolls the page on anything that is not a native button.
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <div
      ref={ref}
      className={cx(
        'mrd-card',
        `mrd-card--elevation-${elevation}`,
        padded && 'mrd-card--padded',
        interactive && 'mrd-card--interactive',
        interactive && 'mrd-focus-ring',
        className,
      )}
      data-selected={selected ? 'true' : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive && selected !== undefined ? selected : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : onKeyDown}
      {...rest}
    >
      {children}
    </div>
  );
});

/* ------------------------------------------------------------------ */

export interface ToolbarProps extends HTMLAttributes<HTMLElement> {
  /** Names the chrome for landmark navigation, e.g. "Session controls". */
  label?: string;
}

/**
 * The translucent top chrome.
 *
 * Deliberately not role="toolbar": that role promises roving-tabindex arrow
 * navigation, and a bar whose contents are arbitrary — menus, search fields,
 * segmented controls — cannot honour it. Each control keeps its own tab stop.
 */
export const Toolbar = forwardRef<HTMLElement, ToolbarProps>(function Toolbar({ label, className, children, ...rest }, ref) {
  return (
    <header ref={ref} className={cx('mrd-toolbar', className)} aria-label={label} {...rest}>
      {children}
    </header>
  );
});

export interface ToolbarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Takes the free space, pushing later groups to the far edge. */
  grow?: boolean;
  align?: 'start' | 'center' | 'end';
  /** Turns the group into a named region; without it the group is presentational. */
  label?: string;
}

export function ToolbarGroup({ grow = false, align = 'start', label, className, children, ...rest }: ToolbarGroupProps): React.JSX.Element {
  return (
    <div
      className={cx('mrd-toolbar__group', grow && 'mrd-toolbar__group--grow', className)}
      data-align={align}
      role={label ? 'group' : undefined}
      aria-label={label}
      {...rest}
    >
      {children}
    </div>
  );
}

export type ToolbarSeparatorProps = HTMLAttributes<HTMLDivElement>;

export function ToolbarSeparator({ className, ...rest }: ToolbarSeparatorProps): React.JSX.Element {
  return <div className={cx('mrd-toolbar__separator', className)} role="separator" aria-orientation="vertical" {...rest} />;
}

/* ------------------------------------------------------------------ */

interface SidebarContextValue {
  collapsed: boolean;
}

/** Lets items and sections adapt without every call site threading the flag. */
const SidebarContext = createContext<SidebarContextValue>({ collapsed: false });

export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  collapsed?: boolean;
  /** Distinguishes this nav from every other one in the shell. */
  label?: string;
  header?: ReactNode;
  footer?: ReactNode;
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { collapsed = false, label = 'Sidebar', header, footer, className, children, ...rest },
  ref,
) {
  return (
    <SidebarContext.Provider value={{ collapsed }}>
      <nav ref={ref} className={cx('mrd-sidebar', className)} data-collapsed={collapsed ? 'true' : undefined} aria-label={label} {...rest}>
        {header ? <div className="mrd-sidebar__header">{header}</div> : null}
        <div className="mrd-sidebar__body">{children}</div>
        {footer ? <div className="mrd-sidebar__footer">{footer}</div> : null}
      </nav>
    </SidebarContext.Provider>
  );
});

export interface SidebarSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** A single quiet control, typically an add button. */
  actions?: ReactNode;
}

export function SidebarSection({ title, actions, className, children, ...rest }: SidebarSectionProps): React.JSX.Element {
  const { collapsed } = useContext(SidebarContext);
  const uid = useId();
  const titleId = `${uid}-title`;
  return (
    <section className={cx('mrd-sidebar-section', className)} aria-labelledby={titleId} {...rest}>
      <div className={cx('mrd-sidebar-section__header', collapsed && 'mrd-sr-only')}>
        {/* Hidden visually rather than removed when collapsed: the section keeps
            its accessible name, and a rule in CSS restores the visual grouping
            with a hairline. */}
        <span id={titleId} className="mrd-panel-title mrd-sidebar-section__title mrd-truncate">
          {title}
        </span>
        {actions ? <div className="mrd-sidebar-section__actions">{actions}</div> : null}
      </div>
      <div className="mrd-sidebar-section__items">{children}</div>
    </section>
  );
}

export interface SidebarItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** Sized by the item; pass an icon component, not a box. */
  icon?: ReactNode;
  /** A string, because it is the accessible name when the sidebar is collapsed. */
  label: string;
  /** A count or short status. Folded into the name when collapsed. */
  badge?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
}

export const SidebarItem = forwardRef<HTMLButtonElement, SidebarItemProps>(function SidebarItem(
  { icon, label, badge, trailing, active = false, className, ...rest },
  ref,
) {
  const { collapsed } = useContext(SidebarContext);
  const badgeText = typeof badge === 'string' || typeof badge === 'number' ? String(badge) : undefined;

  return (
    <button
      ref={ref}
      type="button"
      className={cx('mrd-sidebar-item', 'mrd-focus-ring', className)}
      // aria-current, not a colour: the current page must survive being read out.
      aria-current={active ? 'page' : undefined}
      // Collapsed, the label is not rendered, so the name has to be supplied —
      // and the badge with it, or the count disappears entirely.
      aria-label={collapsed ? (badgeText ? `${label} (${badgeText})` : label) : undefined}
      title={label}
      {...rest}
    >
      {icon ? (
        <span className="mrd-sidebar-item__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="mrd-sidebar-item__label mrd-truncate">{label}</span>
      {badge != null ? <span className="mrd-sidebar-item__badge mrd-numeric">{badge}</span> : null}
      {trailing ? <span className="mrd-sidebar-item__trailing">{trailing}</span> : null}
      {/* A glyph, so a collapsed item with pending work still says so without
          relying on the badge's colour. */}
      {badge != null ? <span className="mrd-sidebar-item__dot" aria-hidden="true" /> : null}
    </button>
  );
});

/* ------------------------------------------------------------------ */

export interface SplitPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onResize'> {
  /** 'horizontal' lays the panes side by side; 'vertical' stacks them. */
  direction: 'horizontal' | 'vertical';
  /** Fractions of the container, one per child, summing to 1. */
  sizes: number[];
  /** Floor for each pane, in the same fractional units as `sizes`. */
  minSizes?: number[];
  onSizesChange: (sizes: number[]) => void;
  /** Fraction moved per arrow key press. */
  step?: number;
  separatorLabel?: (index: number) => string;
  children: ReactNode;
}

interface DragState {
  index: number;
  pointerId: number;
  origin: number;
  /** Sizes as they were when the drag began, so movement is absolute. */
  base: number[];
  available: number;
}

/** Falls back to equal panes when the caller's array does not match the children. */
function normalise(sizes: number[], count: number): number[] {
  if (count === 0) return [];
  const usable = sizes.length === count && sizes.every((n) => Number.isFinite(n) && n >= 0);
  const total = usable ? sizes.reduce((a, b) => a + b, 0) : 0;
  if (!usable || total <= 0) return Array.from({ length: count }, () => 1 / count);
  return sizes.map((n) => n / total);
}

/**
 * The resizable layout primitive.
 *
 * Sizes are fractions rather than pixels so a pane keeps its share of the
 * window when the window changes; they are applied as flex-grow, which means
 * the browser does the arithmetic and a rounding error can never leave a gap.
 *
 * A drag only ever moves the two panes either side of the handle, and the pair
 * keeps its combined size — so the fractions still sum to 1 afterwards and no
 * distant pane jumps because of a movement nowhere near it.
 */
export function SplitPane({
  direction,
  sizes,
  minSizes,
  onSizesChange,
  step = 0.02,
  separatorLabel = (index) => `Resize pane ${index + 1}`,
  className,
  children,
  ...rest
}: SplitPaneProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const uid = useId();

  const panes = Children.toArray(children);
  const fractions = normalise(sizes, panes.length);
  const mins = fractions.map((_, i) => clamp(minSizes?.[i] ?? 0, 0, 1));
  const horizontal = direction === 'horizontal';

  /* The handles are a fixed hairline, so they are not part of the space the
     fractions divide; subtracting them keeps a drag tracking the pointer. */
  const measure = useCallback((): number => {
    const root = rootRef.current;
    if (!root) return 1;
    const rect = root.getBoundingClientRect();
    let span = horizontal ? rect.width : rect.height;
    root.querySelectorAll<HTMLElement>(':scope > .mrd-resizer').forEach((handle) => {
      span -= horizontal ? handle.offsetWidth : handle.offsetHeight;
    });
    return Math.max(span, 1);
  }, [horizontal]);

  const resizeBy = useCallback(
    (index: number, delta: number, base: number[]): void => {
      if (index < 0 || index + 1 >= base.length) return;
      const leading = base[index];
      const trailing = base[index + 1];
      const pair = leading + trailing;
      const minLeading = mins[index] ?? 0;
      const minTrailing = mins[index + 1] ?? 0;
      // Both floors cannot be honoured at once; leave the panes where they are
      // rather than shrinking one below what the caller declared it needs.
      if (minLeading + minTrailing >= pair) return;
      const next = clamp(leading + delta, minLeading, pair - minTrailing);
      if (next === leading) return;
      const updated = base.slice();
      updated[index] = next;
      updated[index + 1] = pair - next;
      onSizesChange(updated);
    },
    [mins, onSizesChange],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Capture routes move and up back here even when the pointer outruns the
    // 1px handle, which it always does.
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      index,
      pointerId: event.pointerId,
      origin: horizontal ? event.clientX : event.clientY,
      base: fractions,
      available: measure(),
    };
    setDragging(index);
    // Stops the drag from selecting text in the panes it passes over — which
    // also suppresses the default focus, so the handle takes it explicitly and
    // the arrow keys work straight after a drag.
    event.preventDefault();
    event.currentTarget.focus();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = horizontal ? event.clientX : event.clientY;
    resizeBy(drag.index, (position - drag.origin) / drag.available, drag.base);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
    const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
    const backward = horizontal ? 'ArrowLeft' : 'ArrowUp';
    let delta: number;
    if (event.key === forward) delta = step;
    else if (event.key === backward) delta = -step;
    // Home and End run the handle to its limits, which is how a keyboard user
    // collapses a pane without holding an arrow key down.
    else if (event.key === 'Home') delta = -1;
    else if (event.key === 'End') delta = 1;
    else return;
    event.preventDefault();
    resizeBy(index, delta, fractions);
  };

  return (
    <div ref={rootRef} className={cx('mrd-splitpane', className)} data-direction={direction} data-resizing={dragging != null ? 'true' : undefined} {...rest}>
      {panes.map((pane, index) => {
        const key = isValidElement(pane) && pane.key != null ? pane.key : index;
        const paneId = `${uid}-pane-${index}`;
        const handleIndex = index - 1;
        const leading = fractions[handleIndex] ?? 0;
        const trailing = fractions[index] ?? 0;
        return (
          <Fragment key={key}>
            {index > 0 ? (
              <div
                className="mrd-resizer"
                role="separator"
                tabIndex={0}
                aria-label={separatorLabel(handleIndex)}
                aria-orientation={horizontal ? 'vertical' : 'horizontal'}
                aria-controls={`${uid}-pane-${handleIndex}`}
                aria-valuenow={Math.round(leading * 100)}
                aria-valuemin={Math.round((mins[handleIndex] ?? 0) * 100)}
                aria-valuemax={Math.round((leading + trailing - (mins[index] ?? 0)) * 100)}
                aria-valuetext={`${Math.round(leading * 100)}%`}
                data-orientation={horizontal ? 'vertical' : 'horizontal'}
                data-dragging={dragging === handleIndex ? 'true' : undefined}
                onPointerDown={(event) => handlePointerDown(event, handleIndex)}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => handleKeyDown(event, handleIndex)}
              />
            ) : null}
            <div className="mrd-splitpane__pane" id={paneId} style={{ flexGrow: fractions[index] }}>
              {pane}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export interface StatusBarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  /** Names the strip for landmark navigation. */
  label?: string;
}

/**
 * The bottom strip. Not a live region: it holds standing facts — connection,
 * counts, the active route — and announcing every change to a token counter
 * would make the app unusable with a screen reader. Anything that genuinely
 * needs announcing carries its own aria-live.
 */
export function StatusBar({ left, center, right, label = 'Status', className, ...rest }: StatusBarProps): React.JSX.Element {
  return (
    <footer className={cx('mrd-statusbar', className)} aria-label={label} {...rest}>
      <div className="mrd-statusbar__left">{left}</div>
      <div className="mrd-statusbar__center">{center}</div>
      <div className="mrd-statusbar__right">{right}</div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** An icon or a small illustration. Decorative — the title carries the meaning. */
  icon?: ReactNode;
  title: ReactNode;
  /** One sentence saying what to do next, not an apology. */
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: 'sm' | 'md';
  /** Renders the title as a heading when the empty state owns the region. */
  headingLevel?: HeadingLevel;
  /** Announce politely — for a state that replaces results after a filter. */
  live?: boolean;
}

/**
 * What a region says when it has nothing to show, which for a gateway is most
 * regions on the first run. It is centred in whatever space it is given and
 * ends in an action, so an empty panel is a starting point rather than a
 * dead end.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, secondaryAction, size = 'md', headingLevel, live = false, className, children, ...rest },
  ref,
) {
  // A heading is right when this names its region, and wrong when the region
  // already has one — an invented level would corrupt the outline.
  const Title = headingLevel ? headingTag(headingLevel) : 'p';
  return (
    <div
      ref={ref}
      className={cx('mrd-empty-state', `mrd-empty-state--${size}`, className)}
      aria-live={live ? 'polite' : undefined}
      {...rest}
    >
      {icon ? (
        <div className="mrd-empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <Title className="mrd-empty-state__title mrd-section-title">{title}</Title>
      {description ? <p className="mrd-empty-state__description mrd-secondary">{description}</p> : null}
      {children}
      {action || secondaryAction ? (
        <div className="mrd-empty-state__actions">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */

export interface InspectorProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  headingLevel?: HeadingLevel;
  /** Used when there is no title, so the column is still findable. */
  label?: string;
  /** Off when the body scrolls in sections of its own. */
  scroll?: boolean;
  padded?: boolean;
}

/**
 * The right-hand column: properties of whatever is selected in the middle.
 * Its width is fixed by token so the centre column is the one that flexes —
 * the inspector holding steady while the content resizes is what makes a
 * selection feel like it is being examined rather than moved.
 */
export const Inspector = forwardRef<HTMLElement, InspectorProps>(function Inspector(
  { title, subtitle, actions, footer, headingLevel = 2, label, scroll = true, padded = true, className, children, ...rest },
  ref,
) {
  const uid = useId();
  const titleId = `${uid}-title`;
  return (
    <aside
      ref={ref}
      className={cx('mrd-inspector', className)}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : (label ?? 'Inspector')}
      {...rest}
    >
      {title ? <PanelHeader title={title} subtitle={subtitle} actions={actions} headingLevel={headingLevel} titleId={titleId} /> : null}
      <PanelBody scroll={scroll} padded={padded}>
        {children}
      </PanelBody>
      {footer ? <div className="mrd-panel__footer">{footer}</div> : null}
    </aside>
  );
});

/* ------------------------------------------------------------------ */

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  direction?: 'row' | 'column';
  /** An index into the space scale. There is no arbitrary gap. */
  gap?: StackGap;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
  wrap?: boolean;
  inline?: boolean;
}

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { direction = 'row', gap, align, justify, wrap = false, inline = false, className, style, children, ...rest },
  ref,
) {
  // The gap is a token reference rather than a value, so it stays on the scale
  // and still follows any theme that redefines the scale.
  const gapStyle = gap ? ({ '--mrd-stack-gap': `var(--space-${gap})` } as CSSProperties) : undefined;
  return (
    <div
      ref={ref}
      className={cx('mrd-stack', `mrd-stack--${direction}`, inline && 'mrd-stack--inline', className)}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? 'true' : undefined}
      style={gapStyle ? { ...gapStyle, ...style } : style}
      {...rest}
    >
      {children}
    </div>
  );
});
