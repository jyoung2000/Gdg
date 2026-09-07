import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button, IconButton } from '../primitives/Button.js';
import { StatusChip } from '../primitives/Controls.js';
import { cx } from '../primitives/util.js';
import {
  IconArrowDown,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconInfo,
  IconPaperclip,
  IconSend,
  IconStop,
} from '../icons/icons.js';

/* ------------------------------------------------------------------ */
/* Messages                                                           */
/* ------------------------------------------------------------------ */

export interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: ReactNode;
  model?: string;
  provider?: string;
  timestamp?: number;
  streaming?: boolean;
  usage?: { totalTokens: number; cost: number };
  latencyMs?: number;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * One message.
 *
 * User messages sit in a tinted bubble on the trailing edge; assistant messages
 * are full-width plain text. Bubbling long assistant output would waste the
 * horizontal space that makes code and lists readable, which is the opposite of
 * what a developer tool needs.
 */
export function ChatMessage({
  role,
  content,
  model,
  provider,
  streaming,
  usage,
  latencyMs,
  actions,
  children,
  className,
}: ChatMessageProps): React.JSX.Element {
  const meta = [provider, model].filter(Boolean).join(' · ');
  return (
    <article className={cx('mrd-msg', `mrd-msg--${role}`, className)} aria-busy={streaming || undefined}>
      <div className="mrd-msg__content">
        {typeof content === 'string' ? <StreamingText text={content} streaming={streaming} /> : content}
      </div>
      {(meta || usage || actions) && role !== 'user' && (
        <div className="mrd-msg__meta">
          {meta && <span className="mrd-caption mrd-truncate">{meta}</span>}
          {latencyMs != null && <span className="mrd-caption mrd-numeric">{(latencyMs / 1000).toFixed(1)}s</span>}
          {usage && (
            <span className="mrd-caption mrd-numeric">
              {usage.totalTokens} tokens{usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ''}
            </span>
          )}
          <div className="mrd-spacer" />
          {actions}
        </div>
      )}
      {children}
    </article>
  );
}

export interface StreamingTextProps {
  text: string;
  streaming?: boolean;
  className?: string;
}

/** Text with a caret while it is still arriving. The caret stops under reduced motion. */
export function StreamingText({ text, streaming, className }: StreamingTextProps): React.JSX.Element {
  return (
    <span className={cx('mrd-streaming', className)}>
      {text}
      {streaming && <span className="mrd-streaming__caret" aria-hidden="true" />}
    </span>
  );
}

export interface ChatMessageListProps {
  children: ReactNode;
  className?: string;
}

/**
 * The scrolling conversation.
 *
 * It follows new content only while the reader is already at the bottom.
 * Yanking someone back down while they are reading earlier output is the single
 * most irritating thing a streaming interface can do.
 */
export function ChatMessageList({ children, className }: ChatMessageListProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [detached, setDetached] = useState(false);

  const atBottom = useCallback((el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 48, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => setDetached(!atBottom(el));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [atBottom]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || detached) return;
    el.scrollTop = el.scrollHeight;
  });

  return (
    <div className={cx('mrd-msglist', className)}>
      <div className="mrd-msglist__scroll mrd-scroll" ref={ref}>
        {children}
      </div>
      {detached && (
        <Button
          className="mrd-msglist__jump"
          size="sm"
          variant="secondary"
          icon={<IconArrowDown />}
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
            setDetached(false);
          }}
        >
          Jump to latest
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composer                                                           */
/* ------------------------------------------------------------------ */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttach?: (files: File[]) => void;
  /**
   * Controlled attachments. When provided, the composer renders exactly this
   * list and reports every change through `onAttachmentsChange`, so the parent
   * can clear the tray after sending and reflect removals — an attachment the
   * parent cannot see leave is an attachment that gets sent after the user
   * deleted it.
   */
  attachments?: File[];
  onAttachmentsChange?: (files: File[]) => void;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  className?: string;
}

const MAX_COMPOSER_HEIGHT = 260;

/**
 * The central interaction.
 *
 * Enter sends and Shift+Enter breaks the line, which is the convention every
 * chat interface has settled on. The textarea grows with its content up to a
 * ceiling and then scrolls, so a long prompt never swallows the conversation.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  onAttach,
  attachments: controlled,
  onAttachmentsChange,
  running = false,
  disabled = false,
  placeholder = 'Describe what you want…',
  leftSlot,
  rightSlot,
  className,
}: ComposerProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [internal, setInternal] = useState<File[]>([]);
  const attachments = controlled ?? internal;
  const changeAttachments = (next: File[]): void => {
    setInternal(next);
    onAttachmentsChange?.(next);
  };

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    // Reset before measuring, or the height only ever grows.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  // Not memoised: it closes over the current attachment list, and a stale
  // closure here would silently drop files added in quick succession.
  const addFiles = (files: File[]): void => {
    if (!files.length) return;
    changeAttachments([...attachments, ...files]);
    onAttach?.(files);
  };

  return (
    <div
      className={cx('mrd-composer', dragging && 'mrd-composer--dragging', disabled && 'mrd-composer--disabled', className)}
      onDragOver={(e) => {
        if (!onAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!onAttach) return;
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {attachments.length > 0 && (
        <div className="mrd-composer__attachments">
          {attachments.map((f, i) => (
            <span key={`${f.name}-${i}`} className="mrd-composer__chip">
              <span className="mrd-truncate">{f.name}</span>
              <IconButton
                label={`Remove ${f.name}`}
                icon={<IconClose />}
                size="sm"
                onClick={() => changeAttachments(attachments.filter((_, idx) => idx !== i))}
              />
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textarea}
        className="mrd-composer__input mrd-focus-ring"
        value={value}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!disabled && !running && value.trim()) onSubmit();
          }
        }}
        onPaste={(e) => {
          if (!onAttach) return;
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
      />

      <div className="mrd-composer__bar">
        {onAttach && (
          <>
            <IconButton label="Attach files" icon={<IconPaperclip />} size="sm" onClick={() => fileInput.current?.click()} />
            <input
              ref={fileInput}
              type="file"
              multiple
              className="mrd-sr-only"
              onChange={(e) => {
                addFiles([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = '';
              }}
            />
          </>
        )}
        {leftSlot}
        <div className="mrd-spacer" />
        {rightSlot}
        {running ? (
          <Button size="sm" variant="secondary" icon={<IconStop />} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<IconSend />} disabled={disabled || !value.trim()} onClick={onSubmit}>
            Run
          </Button>
        )}
      </div>

      {dragging && <div className="mrd-composer__drop">Drop files to attach</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool calls and fallback                                            */
/* ------------------------------------------------------------------ */

export interface ToolCallCardProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  error?: string | null;
  durationMs?: number;
  className?: string;
}

/** A collapsed one-line summary that expands to the full call. */
export function ToolCallCard({ name, args, result, error, durationMs, className }: ToolCallCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = `tool-${name}-${Math.abs(hash(JSON.stringify(args)))}`;

  return (
    <div className={cx('mrd-toolcall', error && 'mrd-toolcall--error', className)}>
      <button className="mrd-toolcall__header mrd-focus-ring" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {open ? <IconChevronDown /> : <IconChevronRight />}
        <span className="mrd-toolcall__name mrd-code">{name}</span>
        <span className="mrd-toolcall__preview mrd-caption mrd-truncate">{preview(args)}</span>
        <div className="mrd-spacer" />
        {durationMs != null && <span className="mrd-caption mrd-numeric">{formatMs(durationMs)}</span>}
        <StatusChip status={error ? 'degraded' : 'ready'} label={error ? 'failed' : 'ok'} size="sm" />
      </button>
      {open && (
        <div className="mrd-toolcall__body" id={id}>
          <pre className="mrd-code mrd-toolcall__pre">{JSON.stringify(args, null, 2)}</pre>
          {(result ?? error) && <pre className="mrd-code mrd-toolcall__pre">{error ?? result}</pre>}
        </div>
      )}
    </div>
  );
}

export interface FallbackNoticeProps {
  message: string;
  provider?: string;
  reason?: string;
  fallbackModel?: string | null;
  impact?: string;
  className?: string;
}

/**
 * The provider-failure explanation.
 *
 * Deliberately rendered on the informational surface rather than the error one:
 * a failure the system recovered from without the user noticing is normal
 * operation, and dressing it in red teaches people to distrust a working
 * product.
 */
export function FallbackNotice({ message, provider, reason, fallbackModel, impact, className }: FallbackNoticeProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('mrd-fallback', className)}>
      <div className="mrd-fallback__head">
        <IconInfo />
        <span className="mrd-fallback__message">{message}</span>
      </div>
      <div className="mrd-fallback__ok">
        <IconCheck />
        <span className="mrd-caption">Task continuing</span>
        <div className="mrd-spacer" />
        <button className="mrd-fallback__toggle mrd-focus-ring" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide detail' : 'Detail'}
        </button>
      </div>
      {open && (
        <dl className="mrd-fallback__detail">
          <dt className="mrd-caption">Provider</dt>
          <dd className="mrd-secondary">{provider ?? 'unknown'}</dd>
          <dt className="mrd-caption">Reason</dt>
          <dd className="mrd-secondary">{humaniseReason(reason)}</dd>
          <dt className="mrd-caption">Fallback</dt>
          <dd className="mrd-secondary">{fallbackModel ?? 'none available'}</dd>
          <dt className="mrd-caption">Expected impact</dt>
          <dd className="mrd-secondary">{impact ?? 'A slightly different model answered. Quality and cost may differ.'}</dd>
        </dl>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal                                                           */
/* ------------------------------------------------------------------ */

export interface TerminalProps {
  onData?: (data: string) => void;
  /** The parent fills this in and calls it to write output. */
  writeRef?: React.MutableRefObject<((text: string) => void) | null>;
  className?: string;
}

/**
 * An xterm.js surface themed from the CSS custom properties.
 *
 * xterm needs literal colour values rather than var() references, so the tokens
 * are resolved at mount and re-resolved when the theme attribute changes — a
 * MutationObserver rather than a React dependency, because the theme lives on
 * the document element, not in this tree.
 */
export function Terminal({ onData, writeRef, className }: TerminalProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;

    const readTheme = (): Record<string, string> => {
      const s = getComputedStyle(document.documentElement);
      const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback;
      return {
        background: v('--color-surface-sunken', '#131314'),
        foreground: v('--color-text-primary', '#f0efed'),
        cursor: v('--color-accent', '#5b8dff'),
        selectionBackground: v('--color-accent-subtle-hover', 'rgba(91,141,255,0.24)'),
        black: v('--color-text-tertiary', '#6e6c68'),
        red: v('--color-error', '#f2635f'),
        green: v('--color-success', '#3fbc80'),
        yellow: v('--color-warning', '#dfa044'),
        blue: v('--color-accent', '#5b8dff'),
        magenta: v('--syntax-keyword', '#c393f0'),
        cyan: v('--syntax-type', '#58c1dd'),
        white: v('--color-text-secondary', '#9e9c97'),
      };
    };

    const instance = new XTerm({
      convertEol: true,
      cursorBlink: false,
      disableStdin: !onDataRef.current,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 5000,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(el);
    term.current = instance;
    if (writeRef) writeRef.current = (text: string) => instance.write(text);

    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // fit throws while the host has no layout, e.g. inside a hidden drawer.
      }
    };
    refit();

    const observer = new ResizeObserver(refit);
    observer.observe(el);

    const themeObserver = new MutationObserver(() => {
      instance.options.theme = readTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const disposable = instance.onData((d) => onDataRef.current?.(d));

    return () => {
      disposable.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
      term.current = null;
      if (writeRef) writeRef.current = null;
    };
  }, [writeRef]);

  return <div ref={host} className={cx('mrd-terminal', className)} />;
}

/* ------------------------------------------------------------------ */

function preview(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 2);
  if (!entries.length) return '';
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
    .join('  ');
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function humaniseReason(code: string | undefined): string {
  switch (code) {
    case 'rate_limited':
      return 'The provider was rate limiting requests.';
    case 'quota_exhausted':
      return 'The quota on that provider was used up.';
    case 'timeout':
      return 'The provider did not respond in time.';
    case 'authentication_failed':
      return 'The provider rejected the credential.';
    case 'server_error':
      return 'The provider returned an error.';
    case 'provider_unavailable':
      return 'The provider was unreachable.';
    default:
      return code ?? 'unknown';
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
