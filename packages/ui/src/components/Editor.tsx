import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { Button, IconButton } from '../primitives/Button.js';
import { SegmentedControl } from '../primitives/Controls.js';
import { cx } from '../primitives/util.js';
import { IconCheck, IconClose, IconCopy } from '../icons/icons.js';

/**
 * The editor surface.
 *
 * Themed entirely through CSS custom properties rather than a second light and
 * dark theme definition: the tokens already switch with the document, so the
 * editor follows without CodeMirror ever knowing a theme changed. The syntax
 * colours are declared as their own tokens in tokens.css under the
 * `--syntax-*` names used below.
 */

/** Map a file extension to a language extension. Unknown types get none. */
export function languageFor(path: string | undefined): Extension[] {
  if (!path) return [];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return [javascript({ typescript: true, jsx: ext === 'tsx' })];
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript({ jsx: ext === 'jsx' })];
    case 'py':
      return [python()];
    case 'json':
      return [json()];
    case 'html':
    case 'htm':
      return [html()];
    case 'css':
      return [css()];
    case 'md':
    case 'markdown':
      return [markdown()];
    default:
      // Plain text is a better outcome than a wrong grammar.
      return [];
  }
}

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--syntax-operator)' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'var(--color-text-primary)' },
  { tag: [tags.tagName], color: 'var(--syntax-keyword)' },
  { tag: [tags.invalid], color: 'var(--color-error)' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)', textDecoration: 'underline' },
  { tag: [tags.heading], color: 'var(--color-text-primary)', fontWeight: '600' },
]);

export const meridianEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--color-text-primary)',
    backgroundColor: 'var(--color-surface)',
    fontSize: 'var(--text-code-size)',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--text-code-line)',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { caretColor: 'var(--color-accent)', padding: 'var(--space-2) 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--color-accent-subtle-hover)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text-tertiary)',
    borderRight: '1px solid var(--color-separator)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-fill-quiet)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-fill-quiet)', color: 'var(--color-text-secondary)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--space-2)', fontVariantNumeric: 'tabular-nums' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--color-accent-subtle)',
    outline: '1px solid var(--color-accent-border)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-fill-active)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-fill-active)',
    color: 'var(--color-text-secondary)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '0 var(--space-1)',
  },
  '.cm-panels': { backgroundColor: 'var(--color-surface-raised)', color: 'var(--color-text-primary)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-warning-subtle)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--color-accent-subtle-hover)' },
  '&.cm-editor.cm-focused': { outline: 'none' },
});

function baseExtensions(): Extension[] {
  // Assembled by hand rather than via basicSetup so nothing arrives that the
  // theme has not accounted for.
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(highlightStyle, { fallback: true }),
    meridianEditorTheme,
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  ];
}

export interface CodeEditorProps {
  value: string;
  path?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  className?: string;
}

export function CodeEditor({ value, path, readOnly = false, onChange, onSave, className }: CodeEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Kept in refs so the editor is created once and never torn down just because
  // a callback identity changed.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useLayoutEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        ...baseExtensions(),
        ...languageFor(path),
        EditorState.readOnly.of(readOnly),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // `value` is deliberately absent: it is synchronised below without
    // rebuilding the view, so the cursor and scroll position survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    // Only replace the document when it genuinely differs, or every keystroke
    // would round-trip through the parent and reset the selection.
    if (current === value) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className={cx('mrd-editor', className)} />;
}

export interface DiffViewerProps {
  before: string | null;
  after: string | null;
  path?: string;
  mode?: 'split' | 'unified';
  onAcceptFile?: () => void;
  onRejectFile?: () => void;
  className?: string;
}

export function DiffViewer({ before, after, path, mode: initialMode = 'split', onAcceptFile, onRejectFile, className }: DiffViewerProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'split' | 'unified'>(initialMode);
  const a = before ?? '';
  const b = after ?? '';
  const counts = countLines(a, b);

  useLayoutEffect(() => {
    if (!host.current) return;
    const language = languageFor(path);

    if (mode === 'split') {
      const merge = new MergeView({
        a: { doc: a, extensions: [...baseExtensions(), ...language, EditorState.readOnly.of(true)] },
        b: { doc: b, extensions: [...baseExtensions(), ...language, EditorState.readOnly.of(true)] },
        parent: host.current,
        collapseUnchanged: { margin: 3, minSize: 6 },
      });
      return () => merge.destroy();
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: b,
        extensions: [...baseExtensions(), ...language, EditorState.readOnly.of(true), unifiedMergeView({ original: a, mergeControls: false })],
      }),
      parent: host.current,
    });
    return () => view.destroy();
  }, [a, b, mode, path]);

  return (
    <div className={cx('mrd-diff', className)}>
      <div className="mrd-diff__header">
        <span className="mrd-diff__path mrd-code mrd-truncate">{path ?? 'diff'}</span>
        <span className="mrd-diff__counts mrd-numeric">
          <span className="mrd-diff__add">+{counts.additions}</span>
          <span className="mrd-diff__del">−{counts.deletions}</span>
        </span>
        <div className="mrd-spacer" />
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={(v) => setMode(v as 'split' | 'unified')}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'unified', label: 'Unified' },
          ]}
        />
        {(onAcceptFile ?? onRejectFile) && (
          <>
            {onRejectFile && (
              <Button size="sm" variant="tertiary" icon={<IconClose />} onClick={onRejectFile}>
                Reject
              </Button>
            )}
            {onAcceptFile && (
              <Button size="sm" variant="primary" icon={<IconCheck />} onClick={onAcceptFile}>
                Accept
              </Button>
            )}
          </>
        )}
      </div>
      <div ref={host} className="mrd-diff__body" />
    </div>
  );
}

export interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
}

/**
 * A read-only code block for chat and tool output. Deliberately not a
 * CodeMirror instance: a message can contain a dozen of these, and a dozen
 * editor views is a real cost for content nobody will edit.
 */
export function CodeBlock({ code, language, filename, className }: CodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the code is still selectable.
    }
  };

  return (
    <figure className={cx('mrd-codeblock', className)}>
      <div className="mrd-codeblock__header">
        <span className="mrd-caption mrd-truncate">{filename ?? language ?? 'code'}</span>
        <IconButton
          label={copied ? 'Copied' : 'Copy code'}
          icon={copied ? <IconCheck /> : <IconCopy />}
          size="sm"
          onClick={() => void copy()}
        />
      </div>
      <pre className="mrd-codeblock__body mrd-code">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function countLines(before: string, after: string): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    additions: b.filter((l) => !setA.has(l)).length,
    deletions: a.filter((l) => !setB.has(l)).length,
  };
}
