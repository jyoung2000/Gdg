import {
  cloneElement,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './Button.js';
import { cx, formatShortcut, isApplePlatform } from './util.js';

/*
 * Interaction timings. These are not motion: they describe how long a person is
 * given to act or to be understood, so they sit outside the duration scale,
 * which exists to be collapsed by reduced-motion.
 */
const TOOLTIP_DELAY_MS = 400;
const TYPEAHEAD_RESET_MS = 700;
const TOAST_DURATION_MS = 6000;

const canUseDOM = typeof document !== 'undefined';

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

function Glyph({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const CheckGlyph = (): React.JSX.Element => (
  <Glyph>
    <path d="M3.5 8.4 6.4 11.3 12.5 4.9" />
  </Glyph>
);
const ChevronRightGlyph = (): React.JSX.Element => (
  <Glyph>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Glyph>
);
const CloseGlyph = (): React.JSX.Element => (
  <Glyph>
    <path d="M4 4 12 12M12 4 4 12" />
  </Glyph>
);

const TOAST_GLYPHS: Record<ToastVariant, () => React.JSX.Element> = {
  info: () => (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.3v3.5M8 5.1h.01" />
    </Glyph>
  ),
  success: () => (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.4 8.2 1.9 1.9 3.4-3.9" />
    </Glyph>
  ),
  warning: () => (
    <Glyph>
      <path d="M8 2.6 14.4 13.4H1.6z" />
      <path d="M8 6.4v3.1M8 11.6h.01" />
    </Glyph>
  ),
  error: () => (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
    </Glyph>
  ),
};

/* ------------------------------------------------------------------ */
/* Layer stack                                                         */
/* ------------------------------------------------------------------ */

interface OverlayLayer {
  readonly id: number;
  readonly z: number;
  readonly escapable: boolean;
}

const layerStack: OverlayLayer[] = [];
let layerSequence = 0;

/** Reads a length or number token off an element, e.g. "--space-2" → 8. */
function readCssNumber(element: Element, name: string): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Registers an open overlay and hands back its stacking order.
 *
 * A menu opened from inside a dialog has a *lower* z token than the dialog it
 * sits in, so the token alone would paint it behind the modal. Each layer
 * therefore takes the greater of its own token and one step above the current
 * top of the stack. `escapable` layers form the Escape chain: only the topmost
 * one answers the key, so dismissing a menu inside a dialog does not also
 * dismiss the dialog underneath it.
 */
function useOverlayLayer(active: boolean, token: string, escapable: boolean): { z: number | undefined; isTopmost: () => boolean } {
  const [z, setZ] = useState<number>();
  const layerRef = useRef<OverlayLayer | null>(null);

  useLayoutEffect(() => {
    if (!active || !canUseDOM) return;
    const base = readCssNumber(document.documentElement, token);
    const top = layerStack.length > 0 ? layerStack[layerStack.length - 1].z : 0;
    const layer: OverlayLayer = { id: (layerSequence += 1), z: Math.max(base, top + 1), escapable };
    layerStack.push(layer);
    layerRef.current = layer;
    setZ(layer.z);
    return () => {
      const index = layerStack.indexOf(layer);
      if (index >= 0) layerStack.splice(index, 1);
      layerRef.current = null;
      setZ(undefined);
    };
  }, [active, token, escapable]);

  const isTopmost = useCallback(() => {
    for (let i = layerStack.length - 1; i >= 0; i -= 1) {
      if (layerStack[i].escapable) return layerStack[i].id === layerRef.current?.id;
    }
    return false;
  }, []);

  return { z, isTopmost };
}

function useEscapeKey(active: boolean, isTopmost: () => boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active || !canUseDOM) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopmost()) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, isTopmost, onEscape]);
}

/* ------------------------------------------------------------------ */
/* Focus and scroll                                                    */
/* ------------------------------------------------------------------ */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // getClientRects() is empty for anything display:none or inside a closed
    // <details>, which querySelectorAll cannot express.
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Moves focus into an overlay on open and gives it back on close.
 *
 * The restore is conditional: by the time this cleanup runs the panel is gone
 * and focus has fallen to <body>, which is the signal that the overlay was
 * holding it. If focus has already landed somewhere else — the user clicked
 * another control to dismiss — taking it back would be a hijack.
 */
function useOverlayFocus(active: boolean, panelRef: RefObject<HTMLElement | null>, moveFocus: boolean, initialFocus?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active || !canUseDOM) return;
    const opener = document.activeElement as HTMLElement | null;
    if (moveFocus) {
      const panel = panelRef.current;
      const target = initialFocus?.current ?? (panel ? focusableWithin(panel)[0] ?? panel : null);
      // preventScroll: the panel is still at the viewport origin on the frame
      // it is measured, so a scrolling focus would jump the page.
      target?.focus({ preventScroll: true });
    }
    return () => {
      const current = document.activeElement;
      if ((!current || current === document.body) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // Re-running on a changed ref would re-steal focus mid-interaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, moveFocus]);
}

/** Tab and Shift+Tab cycle inside the panel instead of escaping to the page. */
function trapTabKey(event: ReactKeyboardEvent<HTMLElement>, panel: HTMLElement | null): void {
  if (event.key !== 'Tab' || !panel || event.defaultPrevented) return;
  const items = focusableWithin(panel);
  if (items.length === 0) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

let scrollLocks = 0;
let previousBodyOverflow = '';

function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || !canUseDOM) return;
    if (scrollLocks === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = previousBodyOverflow;
    };
  }, [active]);
}

/* ------------------------------------------------------------------ */
/* Positioning                                                         */
/* ------------------------------------------------------------------ */

export type Placement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'left-start'
  | 'left-end'
  | 'right'
  | 'right-start'
  | 'right-end';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';

/** A rect to anchor against when there is no element — a pointer, say. */
export interface VirtualAnchor {
  left: number;
  top: number;
  width?: number;
  height?: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Position {
  left: number;
  top: number;
  placement: Placement;
  anchorWidth: number;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function splitPlacement(placement: Placement): [Side, Align] {
  const [side, align] = placement.split('-') as [Side, Align | undefined];
  return [side, align ?? 'center'];
}

function mainAxis(side: Side, anchor: Rect, width: number, height: number, gap: number): number {
  switch (side) {
    case 'top':
      return anchor.top - height - gap;
    case 'bottom':
      return anchor.top + anchor.height + gap;
    case 'left':
      return anchor.left - width - gap;
    default:
      return anchor.left + anchor.width + gap;
  }
}

function overflowsSide(side: Side, anchor: Rect, width: number, height: number, gap: number, pad: number, viewW: number, viewH: number): boolean {
  const value = mainAxis(side, anchor, width, height, gap);
  if (side === 'top') return value < pad;
  if (side === 'bottom') return value + height > viewH - pad;
  if (side === 'left') return value < pad;
  return value + width > viewW - pad;
}

function alignCross(start: number, anchorSize: number, panelSize: number, align: Align): number {
  if (align === 'start') return start;
  if (align === 'end') return start + anchorSize - panelSize;
  return start + (anchorSize - panelSize) / 2;
}

/** Keeps the panel inside the viewport; a panel larger than it pins to the top edge. */
function clampAxis(value: number, size: number, viewport: number, pad: number): number {
  const max = viewport - pad - size;
  if (max <= pad) return pad;
  return Math.min(Math.max(value, pad), max);
}

/**
 * Place the panel, flip it to the opposite side when it would overflow, and
 * clamp it into the viewport.
 *
 * The flip is conditional on the opposite side actually having room: flipping
 * into a second overflow only moves the problem, and a menu that jumps above
 * its trigger to be clipped anyway is worse than one that stays put and gets
 * clamped.
 */
function computePosition(anchor: Rect, width: number, height: number, requested: Placement, gap: number, pad: number, viewW: number, viewH: number): Omit<Position, 'anchorWidth'> {
  let [side, align] = splitPlacement(requested);
  if (overflowsSide(side, anchor, width, height, gap, pad, viewW, viewH) && !overflowsSide(OPPOSITE[side], anchor, width, height, gap, pad, viewW, viewH)) {
    side = OPPOSITE[side];
  }

  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    top = mainAxis(side, anchor, width, height, gap);
    left = alignCross(anchor.left, anchor.width, width, align);
  } else {
    left = mainAxis(side, anchor, width, height, gap);
    top = alignCross(anchor.top, anchor.height, height, align);
  }

  return {
    // Rounded, because a panel on a half pixel renders its text blurry.
    left: Math.round(clampAxis(left, width, viewW, pad)),
    top: Math.round(clampAxis(top, height, viewH, pad)),
    placement: (align === 'center' ? side : `${side}-${align}`) as Placement,
  };
}

/**
 * Measure, place, and keep the panel with its anchor.
 *
 * The gap and the viewport margin are read off the panel's own custom
 * properties rather than passed as numbers, so the geometry the positioner
 * computes and the geometry the stylesheet paints cannot drift apart.
 */
function useAnchoredPosition(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  getAnchorRect: () => Rect | null,
  placement: Placement,
  anchorKey: string,
): Position | null {
  const [position, setPosition] = useState<Position | null>(null);

  const update = useCallback(() => {
    const panel = panelRef.current;
    const anchor = getAnchorRect();
    if (!panel || !anchor) return;
    const box = panel.getBoundingClientRect();
    const next: Position = {
      ...computePosition(
        anchor,
        box.width,
        box.height,
        placement,
        readCssNumber(panel, '--mrd-anchor-gap'),
        readCssNumber(panel, '--mrd-viewport-pad'),
        // clientWidth/Height exclude a classic scrollbar, so a clamped panel
        // never ends up sitting underneath one.
        document.documentElement.clientWidth,
        document.documentElement.clientHeight,
      ),
      anchorWidth: anchor.width,
    };
    setPosition((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.placement === next.placement && prev.anchorWidth === next.anchorWidth ? prev : next,
    );
    // anchorKey re-runs the measure when a virtual anchor moves under an open panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAnchorRect, panelRef, placement, anchorKey]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    update();
    // Capture: the anchor may live inside any scrolling pane, and scroll does
    // not bubble.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    // Content that grows — a menu that loads its items — has to be re-placed,
    // or a bottom-flipped panel grows off the edge it just flipped away from.
    const panel = panelRef.current;
    let observer: ResizeObserver | null = null;
    if (panel && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(panel);
    }
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [open, update, panelRef]);

  return position;
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

export interface PopoverTriggerProps {
  ref: (node: HTMLElement | null) => void;
  'aria-haspopup': 'dialog' | 'menu' | 'listbox' | 'true';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: ReactMouseEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

export type PopoverAnchor = RefObject<HTMLElement | null> | VirtualAnchor | ((props: PopoverTriggerProps) => ReactNode);

export type PopoverRole = 'dialog' | 'menu' | 'listbox' | 'group' | 'none';

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'children' | 'id' | 'autoFocus'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A ref to the trigger, a render prop that receives the trigger wiring, or a point. */
  anchor: PopoverAnchor;
  placement?: Placement;
  role?: PopoverRole;
  /** A role="dialog" surface with neither of these announces as an unnamed dialog. */
  label?: string;
  labelledBy?: string;
  /** Matches the trigger's width — what a select-style popover wants. */
  matchAnchorWidth?: boolean;
  /** Moves focus into the panel on open. Menu turns this off to focus an item. */
  autoFocus?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  id?: string;
  children: ReactNode;
}

function isAnchorRef(anchor: PopoverAnchor): anchor is RefObject<HTMLElement | null> {
  return typeof anchor === 'object' && anchor !== null && 'current' in anchor;
}

/**
 * A floating surface tied to an anchor.
 *
 * It portals to <body> so no ancestor's overflow, transform or stacking context
 * can clip it — the single most common reason a menu appears cut in half — and
 * pays for that with a hand-rolled positioner, since a portalled panel no
 * longer inherits the anchor's coordinate space.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    open,
    onOpenChange,
    anchor,
    placement = 'bottom-start',
    role = 'dialog',
    label,
    labelledBy,
    matchAnchorWidth = false,
    autoFocus = true,
    initialFocus,
    id,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const panelId = id ?? `mrd-popover-${generatedId}`;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<PopoverAnchor>(anchor);

  useLayoutEffect(() => {
    anchorRef.current = anchor;
  });

  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
    },
    [ref],
  );

  const anchorElement = useCallback((): HTMLElement | null => {
    const current = anchorRef.current;
    if (typeof current === 'function') return triggerRef.current;
    if (isAnchorRef(current)) return current.current;
    return null;
  }, []);

  const getAnchorRect = useCallback((): Rect | null => {
    const current = anchorRef.current;
    if (typeof current !== 'function' && !isAnchorRef(current)) {
      return { left: current.left, top: current.top, width: current.width ?? 0, height: current.height ?? 0 };
    }
    const element = anchorElement();
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }, [anchorElement]);

  const anchorKey = typeof anchor !== 'function' && !isAnchorRef(anchor) ? `${anchor.left},${anchor.top}` : 'element';
  const position = useAnchoredPosition(open, panelRef, getAnchorRect, placement, anchorKey);
  const { z, isTopmost } = useOverlayLayer(open, '--z-popover', true);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useEscapeKey(open, isTopmost, close);
  useOverlayFocus(open, panelRef, open && autoFocus, initialFocus);

  useEffect(() => {
    if (!open || !canUseDOM) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The trigger is excluded so its own click can toggle rather than
      // close-then-reopen.
      if (panelRef.current?.contains(target) || anchorElement()?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onOpenChange, anchorElement]);

  const triggerProps: PopoverTriggerProps = {
    ref: (node) => {
      triggerRef.current = node;
    },
    'aria-haspopup': role === 'menu' || role === 'listbox' || role === 'dialog' ? role : 'true',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    onClick: () => onOpenChange(!open),
    onKeyDown: (event) => {
      if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      event.preventDefault();
      onOpenChange(true);
    },
  };

  const panel =
    open && canUseDOM
      ? createPortal(
          <div
            ref={setPanel}
            id={panelId}
            role={role === 'none' ? undefined : role}
            aria-label={label}
            aria-labelledby={labelledBy}
            tabIndex={-1}
            className={cx('mrd-popover', className)}
            data-placement={position?.placement ?? placement}
            data-positioned={position ? 'true' : undefined}
            style={{
              ...style,
              // After the caller's style: a panel that cannot be trusted to sit
              // where it was measured is worse than one that cannot be themed.
              zIndex: z,
              left: position?.left,
              top: position?.top,
              width: matchAnchorWidth && position ? position.anchorWidth : style?.width,
            }}
            {...rest}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {typeof anchor === 'function' ? anchor(triggerProps) : null}
      {panel}
    </>
  );
});

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';

function menuItems(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
  );
}

/** Typeahead matches the label only; the shortcut column would poison it. */
function itemLabel(item: HTMLElement): string {
  return (item.querySelector('.mrd-menu-item__label') ?? item).textContent?.trim().toLowerCase() ?? '';
}

export interface MenuProps extends Omit<PopoverProps, 'role' | 'autoFocus' | 'matchAnchorWidth'> {
  label?: string;
}

/**
 * A desktop application menu.
 *
 * Focus roves over the items themselves rather than being tracked in state, so
 * the highlight and the focus ring can never disagree, and a menu whose items
 * are composed from groups and separators needs no registration protocol.
 */
export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  { open, onOpenChange, anchor, placement = 'bottom-start', label, labelledBy, className, children, onKeyDown, ...rest },
  ref,
) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openIntent = useRef<'first' | 'last'>('first');
  const typeahead = useRef({ buffer: '', timer: 0 });

  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
    },
    [ref],
  );

  useEffect(() => {
    if (!open) return;
    const items = menuItems(panelRef.current);
    const target = openIntent.current === 'last' ? items[items.length - 1] : items[0];
    target?.focus({ preventScroll: true });
    openIntent.current = 'first';
  }, [open]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const focusAt = (items: HTMLElement[], index: number) => {
    if (items.length === 0) return;
    items[((index % items.length) + items.length) % items.length].focus({ preventScroll: true });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const items = menuItems(panelRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(items, current + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(items, current <= 0 ? items.length - 1 : current - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusAt(items, 0);
        return;
      case 'End':
        event.preventDefault();
        focusAt(items, items.length - 1);
        return;
      case 'Tab':
        // Desktop menus are modal to the keyboard: Tab dismisses rather than
        // walking out of the menu into the page behind it.
        event.preventDefault();
        onOpenChange(false);
        return;
      default:
        break;
    }

    // Space is activation, not typeahead, so it is excluded from the buffer.
    if (event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const state = typeahead.current;
    window.clearTimeout(state.timer);
    state.buffer += event.key.toLowerCase();
    state.timer = window.setTimeout(() => {
      state.buffer = '';
    }, TYPEAHEAD_RESET_MS);
    // A repeated single letter cycles through the items starting with it;
    // a longer buffer re-matches from the current item.
    const start = state.buffer.length === 1 ? current + 1 : Math.max(current, 0);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[((start + i) % items.length + items.length) % items.length];
      if (itemLabel(item).startsWith(state.buffer)) {
        item.focus({ preventScroll: true });
        return;
      }
    }
  };

  const anchorForPopover = useMemo<PopoverAnchor>(() => {
    if (typeof anchor !== 'function') return anchor;
    return (props: PopoverTriggerProps) =>
      anchor({
        ...props,
        onKeyDown: (event: ReactKeyboardEvent) => {
          if (event.key === 'ArrowUp') openIntent.current = 'last';
          props.onKeyDown(event);
        },
      });
  }, [anchor]);

  const context = useMemo<MenuContextValue>(() => ({ close: () => onOpenChange(false) }), [onOpenChange]);

  return (
    <MenuContext.Provider value={context}>
      <Popover
        ref={setPanel}
        open={open}
        onOpenChange={onOpenChange}
        anchor={anchorForPopover}
        placement={placement}
        role="menu"
        label={labelledBy ? undefined : label ?? 'Menu'}
        labelledBy={labelledBy}
        autoFocus={false}
        className={cx('mrd-menu', className)}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        {children}
      </Popover>
    </MenuContext.Provider>
  );
});

/** aria-keyshortcuts wants named keys ("Meta+K"), not the glyphs we paint. */
function ariaKeyShortcut(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase();
      if (key === 'mod') return isApplePlatform() ? 'Meta' : 'Control';
      if (key === 'ctrl') return 'Control';
      if (key === 'alt' || key === 'option') return 'Alt';
      if (key === 'shift') return 'Shift';
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    })
    .join('+');
}

export interface MenuItemProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  icon?: ReactNode;
  /** A combo in `matchesShortcut` form, e.g. "mod+shift+k". */
  shortcut?: string;
  /** Renders a checkmark and makes this a menuitemcheckbox. */
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Draws the trailing chevron and marks the item as opening a submenu. */
  submenu?: boolean;
  onSelect?: () => void;
  closeOnSelect?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, shortcut, checked, destructive = false, disabled = false, submenu = false, onSelect, closeOnSelect = true, className, children, onClick, onPointerEnter, ...rest },
  ref,
) {
  const menu = useContext(MenuContext);

  return (
    <button
      ref={ref}
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-keyshortcuts={shortcut ? ariaKeyShortcut(shortcut) : undefined}
      disabled={disabled}
      // Roving focus: the menu owns the tab stop, the items do not.
      tabIndex={-1}
      className={cx('mrd-menu-item', destructive && 'mrd-menu-item--destructive', className)}
      onPointerEnter={(event: ReactPointerEvent<HTMLButtonElement>) => {
        onPointerEnter?.(event);
        // Desktop menus move the highlight with the pointer, which keeps a
        // single highlight rather than one for hover and one for focus.
        event.currentTarget.focus({ preventScroll: true });
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onSelect?.();
        if (closeOnSelect && !submenu) menu?.close();
      }}
      {...rest}
    >
      <span className="mrd-menu-item__lead" aria-hidden="true">
        {checked ? <CheckGlyph /> : icon}
      </span>
      <span className="mrd-menu-item__label">{children}</span>
      {shortcut ? (
        <span className="mrd-menu-item__shortcut" aria-hidden="true">
          {formatShortcut(shortcut)}
        </span>
      ) : null}
      {submenu ? (
        <span className="mrd-menu-item__chevron" aria-hidden="true">
          <ChevronRightGlyph />
        </span>
      ) : null}
    </button>
  );
});

export interface MenuSeparatorProps extends HTMLAttributes<HTMLDivElement> {}

export const MenuSeparator = forwardRef<HTMLDivElement, MenuSeparatorProps>(function MenuSeparator({ className, ...rest }, ref) {
  return <div ref={ref} role="separator" className={cx('mrd-menu__separator', className)} {...rest} />;
});

export interface MenuGroupProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export const MenuGroup = forwardRef<HTMLDivElement, MenuGroupProps>(function MenuGroup({ label, className, children, ...rest }, ref) {
  const labelId = `mrd-menu-group-${useId()}`;
  return (
    <div ref={ref} role="group" aria-labelledby={label ? labelId : undefined} className={cx('mrd-menu__group', className)} {...rest}>
      {label ? (
        <div id={labelId} className="mrd-menu__group-label mrd-panel-title">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

type TooltipChildProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as { current: HTMLElement | null }).current = node;
}

/** A tip on hover is noise; a tip on a mouse click is a lie about what focus is. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export interface TooltipProps {
  /** Text only. A tooltip is never reachable, so it can hold nothing to reach. */
  content: ReactNode;
  /** A single element that accepts a ref, handlers and aria-describedby. */
  children: ReactElement<TooltipChildProps>;
  placement?: Placement;
  /** Milliseconds of hover or focus before the tip appears. */
  delay?: number;
  disabled?: boolean;
}

/**
 * A description attached to its trigger, not a popover.
 *
 * It clones the child rather than wrapping it because aria-describedby has to
 * sit on the control the user actually focuses — on a wrapper it would never be
 * announced — and because a wrapper element would change the layout of whatever
 * it was asked to describe.
 */
export function Tooltip({ content, children, placement = 'top', delay = TOOLTIP_DELAY_MS, disabled = false }: TooltipProps): React.JSX.Element {
  const tooltipId = `mrd-tooltip-${useId()}`;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef(0);

  const getAnchorRect = useCallback((): Rect | null => {
    const element = anchorRef.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }, []);

  const position = useAnchoredPosition(open, panelRef, getAnchorRect, placement, 'element');
  const { z } = useOverlayLayer(open, '--z-tooltip', false);

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setOpen(false);
  }, []);

  const show = useCallback(() => {
    if (disabled) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }, [delay, disabled]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!open || !canUseDOM) return;
    // Escape dismisses the tip without consuming the key: a dialog underneath
    // still needs to see it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hide]);

  const child = children.props;
  const describedBy = open ? cx(child['aria-describedby'], tooltipId) : child['aria-describedby'];

  const trigger = cloneElement(children, {
    // React 19 carries ref in props, so the child's own ref composes here.
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      assignRef(child.ref, node);
    },
    'aria-describedby': describedBy,
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      child.onPointerEnter?.(event);
      show();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      child.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      child.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      child.onFocus?.(event);
      if (isKeyboardFocus(event.currentTarget)) show();
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      child.onBlur?.(event);
      hide();
    },
  } as TooltipChildProps);

  return (
    <>
      {trigger}
      {open && canUseDOM
        ? createPortal(
            <div
              ref={panelRef}
              id={tooltipId}
              role="tooltip"
              className="mrd-tooltip"
              data-placement={position?.placement ?? placement}
              data-positioned={position ? 'true' : undefined}
              style={{ zIndex: z, left: position?.left, top: position?.top }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Modal shell — shared by Dialog and Sheet                            */
/* ------------------------------------------------------------------ */

interface ModalShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  labelledBy: string;
  describedBy?: string;
  scrimClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}

/**
 * Scrim, portal, focus trap and scroll lock — everything both modal surfaces
 * owe the user, in one place so a Sheet cannot quietly lose a guarantee a
 * Dialog makes.
 *
 * There is no exit animation. Keeping the panel mounted past `open` would keep
 * it in the focus trap and in the Escape chain after it has been dismissed,
 * which is a correctness cost the eye does not repay.
 */
function ModalShell({ open, onOpenChange, dismissible, initialFocus, labelledBy, describedBy, scrimClassName, panelClassName, children }: ModalShellProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { z, isTopmost } = useOverlayLayer(open, '--z-modal', true);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useBodyScrollLock(open);
  useEscapeKey(open && dismissible, isTopmost, close);
  useOverlayFocus(open, panelRef, open, initialFocus);

  if (!open || !canUseDOM) return null;

  return createPortal(
    <div
      className={cx('mrd-scrim', scrimClassName)}
      style={{ zIndex: z }}
      onPointerDown={(event) => {
        // Only a press that both starts and lands on the scrim dismisses, so a
        // text selection dragged out of the panel does not close it.
        if (dismissible && event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={panelClassName}
        onKeyDown={(event) => trapTabKey(event, panelRef.current)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ModalContentProps {
  title: string;
  description?: ReactNode;
  titleId: string;
  descriptionId: string;
  showClose: boolean;
  onClose: () => void;
  footer?: ReactNode;
  block: 'dialog' | 'sheet';
  children?: ReactNode;
}

function ModalContent({ title, description, titleId, descriptionId, showClose, onClose, footer, block, children }: ModalContentProps): React.JSX.Element {
  return (
    <>
      <header className={`mrd-${block}__header`}>
        <div className={`mrd-${block}__heading`}>
          <h2 id={titleId} className={cx(`mrd-${block}__title`, 'mrd-section-title')}>
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className={cx(`mrd-${block}__description`, 'mrd-secondary')}>
              {description}
            </p>
          ) : null}
        </div>
        {showClose ? <IconButton size="sm" label="Close" icon={<CloseGlyph />} onClick={onClose} /> : null}
      </header>
      <div className={cx(`mrd-${block}__body`, 'mrd-scroll')}>{children}</div>
      {footer ? <footer className={`mrd-${block}__footer`}>{footer}</footer> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: it is the dialog's accessible name, not decoration. */
  title: string;
  description?: ReactNode;
  size?: DialogSize;
  /** False for a decision that must be answered: Escape and the scrim stop working. */
  dismissible?: boolean;
  /** Where focus lands on open. Defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * A modal question or a modal task.
 *
 * Everything a modal must do — trap focus, restore it, lock the page behind it,
 * answer Escape, and name itself — is handled by the shell; a Dialog is that
 * shell plus a header, a scrolling body and a footer for the actions.
 */
export function Dialog({ open, onOpenChange, title, description, size = 'md', dismissible = true, initialFocus, footer, className, children }: DialogProps): React.JSX.Element | null {
  const id = useId();
  const titleId = `mrd-dialog-title-${id}`;
  const descriptionId = `mrd-dialog-description-${id}`;

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      dismissible={dismissible}
      initialFocus={initialFocus}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      panelClassName={cx('mrd-dialog', `mrd-dialog--${size}`, className)}
    >
      <ModalContent
        block="dialog"
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
        showClose={dismissible}
        onClose={() => onOpenChange(false)}
        footer={footer}
      >
        {children}
      </ModalContent>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

export type SheetSide = 'right' | 'bottom';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: it is the sheet's accessible name, not decoration. */
  title: string;
  description?: ReactNode;
  side?: SheetSide;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * An edge-anchored modal panel.
 *
 * This is what the inspector and the sidebar become when the viewport is too
 * narrow to hold them beside the content, so it carries exactly the Dialog
 * semantics — a drawer that did not trap focus would strand a keyboard user in
 * a layout they cannot see.
 */
export function Sheet({ open, onOpenChange, title, description, side = 'right', dismissible = true, initialFocus, footer, className, children }: SheetProps): React.JSX.Element | null {
  const id = useId();
  const titleId = `mrd-sheet-title-${id}`;
  const descriptionId = `mrd-sheet-description-${id}`;

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      dismissible={dismissible}
      initialFocus={initialFocus}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      scrimClassName={cx('mrd-scrim--sheet', `mrd-scrim--${side}`)}
      panelClassName={cx('mrd-sheet', `mrd-sheet--${side}`, className)}
    >
      <ModalContent
        block="sheet"
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
        showClose={dismissible}
        onClose={() => onOpenChange(false)}
        footer={footer}
      >
        {children}
      </ModalContent>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

const TOAST_VARIANT_LABEL: Record<ToastVariant, string> = {
  info: 'Information',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: ReactNode;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss; 0 keeps the toast until it is dismissed. */
  duration?: number;
  action?: ToastAction;
}

export interface ToastRecord extends ToastOptions {
  id: string;
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string;
  description?: ReactNode;
  variant?: ToastVariant;
  duration?: number;
  action?: ToastAction;
  onDismiss: () => void;
}

/**
 * One notification.
 *
 * The countdown is held as remaining time rather than a fixed timer so it can
 * be paused: a toast that expires while it is being read, or while the pointer
 * is on its way to the action button, is a toast that failed. Hover and focus
 * both hold it, counted, so leaving one while still in the other does not
 * restart the clock.
 */
export const Toast = forwardRef<HTMLDivElement, ToastProps>(function Toast(
  { title, description, variant = 'info', duration = TOAST_DURATION_MS, action, onDismiss, className, ...rest },
  ref,
) {
  const timerRef = useRef(0);
  const remainingRef = useRef(duration);
  const startedRef = useRef(0);
  const holdsRef = useRef(0);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const start = useCallback(() => {
    if (remainingRef.current <= 0) return;
    startedRef.current = Date.now();
    timerRef.current = window.setTimeout(() => dismissRef.current(), remainingRef.current);
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(timerRef.current);
    if (startedRef.current > 0) remainingRef.current -= Date.now() - startedRef.current;
  }, []);

  useEffect(() => {
    remainingRef.current = duration;
    if (duration > 0) start();
    return () => window.clearTimeout(timerRef.current);
  }, [duration, start]);

  const hold = () => {
    holdsRef.current += 1;
    if (holdsRef.current === 1) stop();
  };
  const release = () => {
    holdsRef.current = Math.max(0, holdsRef.current - 1);
    if (holdsRef.current === 0 && duration > 0) start();
  };

  const VariantGlyph = TOAST_GLYPHS[variant];

  return (
    <div
      ref={ref}
      role="status"
      // An error interrupts; anything else waits for a pause in speech.
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cx('mrd-toast', `mrd-toast--${variant}`, className)}
      onPointerEnter={hold}
      onPointerLeave={release}
      onFocus={hold}
      onBlur={release}
      {...rest}
    >
      <span className="mrd-toast__icon" aria-hidden="true">
        <VariantGlyph />
      </span>
      <div className="mrd-toast__content">
        <p className="mrd-toast__title">
          {/* The glyph and the tint carry the status visually; this carries it
              to anyone who gets the text alone. */}
          <span className="mrd-sr-only">{`${TOAST_VARIANT_LABEL[variant]}: `}</span>
          {title}
        </p>
        {description ? <div className="mrd-toast__description mrd-secondary">{description}</div> : null}
      </div>
      {action ? (
        <Button
          size="sm"
          variant="secondary"
          className="mrd-toast__action"
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
        </Button>
      ) : null}
      <IconButton size="sm" label="Dismiss notification" icon={<CloseGlyph />} onClick={onDismiss} />
    </div>
  );
});

export interface ToastContextValue {
  /** Queues a toast and returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
  /** Older toasts drop off the top once the stack is this deep. */
  max?: number;
  duration?: number;
}

export function ToastProvider({ children, max = 4, duration = TOAST_DURATION_MS }: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const sequence = useRef(0);

  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((item) => item.id !== id)), []);
  const dismissAll = useCallback(() => setToasts([]), []);
  const toast = useCallback(
    (options: ToastOptions) => {
      sequence.current += 1;
      const id = `mrd-toast-${sequence.current}`;
      setToasts((prev) => [...prev, { ...options, id, duration: options.duration ?? duration }].slice(-max));
      return id;
    },
    [duration, max],
  );

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss, dismissAll }), [toast, dismiss, dismissAll]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {canUseDOM
        ? createPortal(
            // The region is mounted for the life of the app, not with the first
            // toast: a live region inserted at the same moment as its content
            // is not reliably announced.
            <div className="mrd-toast-viewport" role="region" aria-label="Notifications">
              {toasts.map((item) => (
                <Toast key={item.id} {...item} onDismiss={() => dismiss(item.id)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a <ToastProvider>.');
  return context;
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

/** A stable stand-in while the menu is closed, so the positioner's deps hold still. */
const EMPTY_POINT: VirtualAnchor = { left: 0, top: 0, width: 0, height: 0 };

export interface ContextMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'content'> {
  /** MenuItem / MenuGroup / MenuSeparator children of the menu. */
  content: ReactNode;
  label?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A menu at the pointer.
 *
 * The host is display:contents so wrapping a row, a cell or a canvas in one
 * cannot change its layout. The context-menu key and Shift+F10 open it too,
 * anchored to whatever is focused inside — a context menu reachable only by
 * right-click is a context menu a keyboard user does not have.
 */
export function ContextMenu({ content, label = 'Context menu', disabled = false, onOpenChange, className, children, onContextMenu, onKeyDown, ...rest }: ContextMenuProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [point, setPoint] = useState<VirtualAnchor | null>(null);
  const open = point !== null;

  const setOpen = (next: VirtualAnchor | null) => {
    setPoint(next);
    onOpenChange?.(next !== null);
  };

  return (
    <>
      <div
        ref={hostRef}
        className={cx('mrd-context-menu-host', className)}
        onContextMenu={(event) => {
          onContextMenu?.(event);
          if (disabled || event.defaultPrevented) return;
          event.preventDefault();
          setOpen({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (disabled || event.defaultPrevented) return;
          if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
          event.preventDefault();
          const active = document.activeElement;
          const source = active instanceof HTMLElement && hostRef.current?.contains(active) ? active : hostRef.current?.firstElementChild;
          const box = source?.getBoundingClientRect();
          setOpen(box ? { left: box.left, top: box.bottom, width: 0, height: 0 } : { left: 0, top: 0, width: 0, height: 0 });
        }}
        {...rest}
      >
        {children}
      </div>
      <Menu
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        anchor={point ?? EMPTY_POINT}
        placement="bottom-start"
        label={label}
        className="mrd-menu--at-pointer"
      >
        {content}
      </Menu>
    </>
  );
}

