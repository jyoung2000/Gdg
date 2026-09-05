import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from '../primitives/Controls.js';
import { cx, isApplePlatform, matchesShortcut } from '../primitives/util.js';

const canUseDOM = typeof document !== 'undefined';

/** The one shortcut the palette owns everywhere, including inside a text field. */
const PALETTE_SHORTCUT = 'mod+k';

export interface Command {
  /** Unique and stable: it keys the option element and the active descendant. */
  id: string;
  label: string;
  /** The section this command is filed under, rendered as the group header. */
  group: string;
  icon?: ReactNode;
  /** A combo in `matchesShortcut` form, e.g. "mod+shift+p". */
  shortcut?: string;
  /** Extra words the command is findable by but does not display. */
  keywords?: string[];
  description?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** A run of commands sharing a `group`, in the order the palette renders them. */
export interface CommandGroup {
  group: string;
  commands: Command[];
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/*
 * Score tiers, a thousand apart. Every within-tier adjustment below is clamped
 * well inside that gap, so a better *kind* of match always outranks a worse
 * one however good the worse one is at its own tier: an exact prefix beats a
 * word prefix, which beats a bare substring, which beats a scattered
 * subsequence.
 */
const TIER_PREFIX = 4000;
const TIER_WORD_PREFIX = 3000;
const TIER_SUBSTRING = 2000;
const TIER_SUBSEQUENCE = 1000;

/** Bounds on the within-tier adjustments, keeping the tiers from ever crossing. */
const POSITION_CAP = 40;
const SPREAD_CAP = 40;
const CLAMP = 500;
const WORD_START_BONUS = 12;
const ADJACENT_BONUS = 8;

/** A keyword hit drops below every label hit: the label is what the user reads. */
const KEYWORD_OFFSET = 4000;

const WORD_BREAK = /[^\p{L}\p{N}]/u;

const EMPTY_INDICES: readonly number[] = [];

/** A word starts after a separator, and at a camelCase hump: the G of "openGateway". */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (WORD_BREAK.test(previous)) return true;
  return previous === previous.toLowerCase() && text[index] !== text[index].toLowerCase();
}

/**
 * Walks the query through the text, taking the first occurrence of each
 * character after the last one taken.
 *
 * With `preferWordStarts` it takes the first occurrence that begins a word
 * instead, which matches "gw" to the G and W of "Gateway Workspace" rather than
 * to the G and the w inside "Gateway". That preference can overshoot and strand
 * a later character, so the caller falls back to the plain walk, which succeeds
 * whenever any subsequence exists at all.
 */
function scanSubsequence(text: string, lower: string, query: string, preferWordStarts: boolean): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const char of query) {
    let at = -1;
    if (preferWordStarts) {
      for (let i = from; i < lower.length; i += 1) {
        if (lower[i] === char && isWordStart(text, i)) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) at = lower.indexOf(char, from);
    if (at < 0) return null;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

/** Ids come from the consumer, and whitespace in one would break the IDREF that
    ties aria-activedescendant to the option it names. */
function domId(base: string, value: string): string {
  return `${base}-${value.replace(/\s+/g, '-')}`;
}

interface TextMatch {
  score: number;
  indices: number[];
}

/** `query` arrives already lowercased and trimmed, so it is lowered once per keystroke. */
function matchText(text: string, query: string): TextMatch | null {
  if (query.length > text.length) return null;
  const lower = text.toLowerCase();

  if (lower.startsWith(query)) return { score: TIER_PREFIX, indices: range(0, query.length) };

  // The first occurrence and the first occurrence that begins a word are
  // different hits and different tiers: "way" is a word prefix of "Gateway
  // Waypoint" at 8, not merely a substring at 4.
  const first = lower.indexOf(query);
  let wordStart = first;
  while (wordStart >= 0 && !isWordStart(text, wordStart)) wordStart = lower.indexOf(query, wordStart + 1);
  if (wordStart >= 0) {
    return { score: TIER_WORD_PREFIX - Math.min(wordStart, POSITION_CAP), indices: range(wordStart, query.length) };
  }
  if (first >= 0) {
    return { score: TIER_SUBSTRING - Math.min(first, POSITION_CAP), indices: range(first, query.length) };
  }

  const indices = scanSubsequence(text, lower, query, true) ?? scanSubsequence(text, lower, query, false);
  if (!indices) return null;

  let bonus = 0;
  for (let i = 0; i < indices.length; i += 1) {
    if (isWordStart(text, indices[i])) bonus += WORD_START_BONUS;
    if (i > 0 && indices[i] === indices[i - 1] + 1) bonus += ADJACENT_BONUS;
  }
  bonus -= Math.min(indices[0], POSITION_CAP);
  bonus -= Math.min(indices[indices.length - 1] - indices[0] - (query.length - 1), SPREAD_CAP);

  return { score: TIER_SUBSEQUENCE + Math.max(-CLAMP, Math.min(CLAMP, bonus)), indices };
}

interface CommandMatch {
  command: Command;
  score: number;
  /** Positions in the label to mark. Empty when only a keyword matched. */
  indices: readonly number[];
}

function rankCommands(commands: readonly Command[], query: string): CommandMatch[] {
  const matches: CommandMatch[] = [];

  for (const command of commands) {
    const label = matchText(command.label, query);
    if (label) {
      matches.push({ command, score: label.score, indices: label.indices });
      continue;
    }
    let keywordScore: number | null = null;
    for (const keyword of command.keywords ?? []) {
      const hit = matchText(keyword, query);
      if (hit && (keywordScore === null || hit.score > keywordScore)) keywordScore = hit.score;
    }
    if (keywordScore !== null) matches.push({ command, score: keywordScore - KEYWORD_OFFSET, indices: EMPTY_INDICES });
  }

  // Ties go to the shorter label: between two equally good matches the more
  // specific command is the one with less text around the hit.
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.command.label.length - b.command.label.length ||
      a.command.label.localeCompare(b.command.label),
  );
  return matches;
}

interface PaletteResults {
  groups: CommandGroup[];
  /** Label positions to mark, by command id. */
  highlights: Map<string, readonly number[]>;
  /** Every enabled command in render order — what the arrow keys walk. */
  navigable: Command[];
  /** Whether to reserve the leading icon column, decided over the whole command
      set rather than the matches so the column does not appear as you type. */
  hasIcons: boolean;
}

function buildResults(commands: readonly Command[], rawQuery: string): PaletteResults {
  const query = rawQuery.trim().toLowerCase();
  // An empty query is not a match of everything: it is no ranking at all, so the
  // authored order survives instead of being re-sorted by label length.
  const matches: CommandMatch[] = query
    ? rankCommands(commands, query)
    : commands.map((command) => ({ command, score: 0, indices: EMPTY_INDICES }));

  const highlights = new Map<string, readonly number[]>();
  const buckets = new Map<string, Command[]>();
  for (const match of matches) {
    if (match.indices.length > 0) highlights.set(match.command.id, match.indices);
    const bucket = buckets.get(match.command.group);
    if (bucket) bucket.push(match.command);
    else buckets.set(match.command.group, [match.command]);
  }

  // Matches are already in score order, so a Map keyed by group comes out
  // ordered by each group's best hit — the group holding the top result leads —
  // and falls back to authored order when nothing is ranked.
  const groups = Array.from(buckets, ([group, grouped]) => ({ group, commands: grouped }));
  const navigable = groups.flatMap((group) => group.commands.filter((command) => !command.disabled));

  return { groups, highlights, navigable, hasIcons: commands.some((command) => command.icon) };
}

/* ------------------------------------------------------------------ */

function SearchGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.6" />
      <path d="m10.5 10.5 3.2 3.2" />
    </svg>
  );
}

const SPOKEN_KEYS: Record<string, string> = {
  shift: 'Shift',
  alt: 'Alt',
  option: 'Option',
  ctrl: 'Control',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  space: 'Space',
  up: 'Up arrow',
  down: 'Down arrow',
};

/** Keycap glyphs (⌘ ⇧ ⌥) are announced as symbol names, so shortcuts carry words too. */
function spokenShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((raw) => {
      const part = raw.trim().toLowerCase();
      if (part === 'mod') return isApplePlatform() ? 'Command' : 'Control';
      return SPOKEN_KEYS[part] ?? part.toUpperCase();
    })
    .join(' ');
}

function Highlight({ text, indices }: { text: string; indices?: readonly number[] }): React.JSX.Element {
  if (!indices || indices.length === 0) return <>{text}</>;

  const marked = new Set(indices);
  const runs: ReactNode[] = [];
  let start = 0;
  while (start < text.length) {
    const on = marked.has(start);
    let end = start + 1;
    while (end < text.length && marked.has(end) === on) end += 1;
    const slice = text.slice(start, end);
    runs.push(
      on ? (
        <mark key={start} className="mrd-command-palette__mark">
          {slice}
        </mark>
      ) : (
        <Fragment key={start}>{slice}</Fragment>
      ),
    );
    start = end;
  }
  return <>{runs}</>;
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly Command[];
  placeholder?: string;
  /** Accessible name for the dialog. */
  label?: string;
  className?: string;
}

/**
 * The keyboard route to everything the app can do.
 *
 * The panel is offset from the top of the viewport rather than centred: its
 * height changes with every keystroke, and a vertically centred palette would
 * slide the list out from under the eye as results come and go.
 *
 * It is a combobox, not a menu: focus stays in the search field and the active
 * option is named by aria-activedescendant, so typing and choosing are the same
 * uninterrupted gesture. That is also why an option is a div — a focusable
 * button in the listbox would pull focus off the input the user is still typing
 * into.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  placeholder = 'Search commands…',
  label = 'Command palette',
  className,
}: CommandPaletteProps): React.JSX.Element | null {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Scrolling the active option into view is for keyboard moves only; doing it
      for a hovered row would drag the list out from under the pointer. */
  const keyboardMove = useRef(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);

  const { groups, highlights, navigable, hasIcons } = useMemo(() => buildResults(commands, query), [commands, query]);

  // Deriving the active command rather than storing it means a filtered-away
  // selection heals to the top result instead of leaving Enter pointing at
  // something no longer on screen.
  const active = navigable.find((command) => command.id === activeId) ?? navigable[0] ?? null;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveId(null);
  }, [open]);

  useEffect(() => {
    if (!open || !canUseDOM) return;
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      // Give focus back only if the palette still held it. If the command that
      // ran has already moved focus somewhere deliberate, taking it back would
      // be a hijack.
      const current = document.activeElement;
      if ((!current || current === document.body) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !canUseDOM) return;
    // A second Escape route for the case where focus has ended up outside the
    // panel: a palette that cannot be dismissed is worse than one dismissed
    // twice, and the handler below stops the event before it gets here.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, close]);

  useEffect(() => {
    if (!open || !keyboardMove.current) return;
    keyboardMove.current = false;
    const element = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    element?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId, query]);

  const runCommand = useCallback(
    (command: Command) => {
      if (command.disabled) return;
      // Closing first lets focus return to the opener before the command has a
      // chance to move it somewhere of its own.
      onOpenChange(false);
      void command.run();
    },
    [onOpenChange],
  );

  const move = (delta: number) => {
    if (!active || navigable.length === 0) return;
    const from = navigable.indexOf(active);
    keyboardMove.current = true;
    // Wrapping, because the list is short and a palette that stops dead at the
    // last row makes the first row a long way away.
    setActiveId(navigable[(from + delta + navigable.length) % navigable.length].id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Enter':
        // Enter while an IME candidate is open commits the candidate.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (active) runCommand(active);
        break;
      case 'Escape':
        event.preventDefault();
        // Stopped here: an Escape that also reached the app would dismiss
        // whatever the palette was opened over.
        event.stopPropagation();
        close();
        break;
      case 'Tab':
        // The search field is the palette's only tab stop, so Tab has nowhere
        // to go — and must not leave the dialog to find one.
        event.preventDefault();
        break;
      default:
        break;
    }
  };

  if (!open || !canUseDOM) return null;

  return createPortal(
    <div
      className="mrd-command-palette__scrim"
      onPointerDown={(event) => {
        // Only a press that both starts and lands on the scrim dismisses, so a
        // selection dragged out of the field does not close the palette.
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx('mrd-command-palette', className)}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          // Every press but one on the field itself keeps the caret where it
          // is: a click on a row, a header or the padding between them must not
          // blur the input the user is still typing into. The click that
          // follows is unaffected.
          if (event.target !== inputRef.current) event.preventDefault();
        }}
      >
        <div className="mrd-command-palette__search">
          <span className="mrd-command-palette__search-icon">
            <SearchGlyph />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="mrd-command-palette__input"
            role="combobox"
            aria-expanded={groups.length > 0}
            aria-controls={listId}
            aria-activedescendant={active ? domId(baseId, active.id) : undefined}
            aria-autocomplete="list"
            aria-label="Search commands"
            placeholder={placeholder}
            value={query}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              // A new query means a new best match, and the list should be back
              // at the top showing it.
              keyboardMove.current = true;
              setActiveId(null);
            }}
          />
        </div>

        <div ref={listRef} className={cx('mrd-command-palette__results', 'mrd-scroll')}>
          <div id={listId} role="listbox" aria-label="Commands">
            {groups.map((group) => {
              const headerId = domId(`${baseId}-group`, group.group);
              return (
                <div key={group.group} role="group" aria-labelledby={headerId} className="mrd-command-palette__group">
                  <div id={headerId} role="presentation" className={cx('mrd-command-palette__group-title', 'mrd-panel-title')}>
                    {group.group}
                  </div>
                  {group.commands.map((command) => {
                    const isActive = active?.id === command.id;
                    return (
                      <div
                        key={command.id}
                        id={domId(baseId, command.id)}
                        role="option"
                        aria-selected={isActive}
                        aria-disabled={command.disabled || undefined}
                        className="mrd-command-palette__option"
                        onPointerMove={() => {
                          if (command.disabled || isActive) return;
                          keyboardMove.current = false;
                          setActiveId(command.id);
                        }}
                        onClick={() => runCommand(command)}
                      >
                        {hasIcons ? (
                          <span className="mrd-command-palette__icon" aria-hidden="true">
                            {command.icon}
                          </span>
                        ) : null}
                        <span className="mrd-command-palette__text">
                          <span className={cx('mrd-command-palette__label', 'mrd-truncate')}>
                            <Highlight text={command.label} indices={highlights.get(command.id)} />
                          </span>
                          {command.description ? (
                            <span className={cx('mrd-command-palette__description', 'mrd-truncate')}>{command.description}</span>
                          ) : null}
                        </span>
                        {command.shortcut ? (
                          <Kbd
                            className="mrd-command-palette__shortcut"
                            size="sm"
                            shortcut={command.shortcut}
                            label={`Shortcut ${spokenShortcut(command.shortcut)}`}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {groups.length === 0 ? (
            // role="status" so the dead end is announced rather than left as a
            // silence after the last keystroke.
            <div className="mrd-command-palette__empty" role="status">
              <span className="mrd-command-palette__empty-title">No commands match</span>
              {query.trim() ? <span className={cx('mrd-command-palette__empty-query', 'mrd-secondary', 'mrd-truncate')}>“{query.trim()}”</span> : null}
            </div>
          ) : null}
        </div>

        {/* Hints only: every affordance here is already carried by the dialog's
            semantics, so repeating them to a screen reader is noise. */}
        <div className="mrd-command-palette__footer" aria-hidden="true">
          <span className="mrd-command-palette__hint">
            <Kbd size="sm" shortcut="up" />
            <Kbd size="sm" shortcut="down" />
            Navigate
          </span>
          <span className="mrd-command-palette__hint">
            <Kbd size="sm" shortcut="enter" />
            Run
          </span>
          <span className="mrd-command-palette__hint">
            <Kbd size="sm" shortcut="esc" />
            Close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export interface CommandPaletteController {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  toggle: () => void;
}

/** Typing somewhere should not fire the app's single-purpose shortcuts. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/**
 * Owns the palette's open state and the global keyboard route to it.
 *
 * It also dispatches the commands that carry their own shortcut, which is the
 * reason it wants the command list: the palette and the shortcut are two doors
 * onto the same set of actions, and keeping them in one place stops the two
 * from drifting. Every shortcut but mod+k stands down while the user is typing
 * — mod+k has to keep working there, or the palette is unreachable from the one
 * place people most often want it.
 */
export function useCommandPalette(commands: readonly Command[] = []): CommandPaletteController {
  const [open, setOpen] = useState(false);
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });

  useEffect(() => {
    if (!canUseDOM) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A held key must not flicker the palette, and a key another handler has
      // already claimed is not ours to read.
      if (event.defaultPrevented || event.repeat || event.isComposing) return;

      if (matchesShortcut(event, PALETTE_SHORTCUT)) {
        event.preventDefault();
        setOpen((previous) => !previous);
        return;
      }
      if (isTextEntry(event.target)) return;

      const command = latest.current.find((entry) => entry.shortcut && !entry.disabled && matchesShortcut(event, entry.shortcut));
      if (!command) return;
      event.preventDefault();
      void command.run();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggle = useCallback(() => setOpen((previous) => !previous), []);

  return { open, setOpen, toggle };
}
