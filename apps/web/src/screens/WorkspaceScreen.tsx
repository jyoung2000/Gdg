import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  CodeEditor,
  DiffViewer,
  EmptyState,
  IconButton,
  List,
  ListRow,
  SearchField,
  SegmentedControl,
  SplitPane,
  Stack,
  StatusChip,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFile,
  IconFolder,
  IconFolderOpen,
} from '@meridian/ui';
import type { FileChange, FileNode } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

type CentreView = 'editor' | 'diff';

/**
 * The coding workspace: file tree, editor with tabs, and diff review.
 *
 * The diff view is the product's safety guarantee made visible — an agent's
 * changes are written to disk so tests can run against them, but every change
 * is recorded with its previous content and can be reverted exactly until it is
 * accepted.
 */
export function WorkspaceScreen(): React.JSX.Element {
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const tree = useStore((s) => s.tree);
  const openFiles = useStore((s) => s.openFiles);
  const activeFile = useStore((s) => s.activeFile);
  const changes = useStore((s) => s.changes);
  const openFile = useStore((s) => s.openFile);
  const closeFile = useStore((s) => s.closeFile);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const updateFileContent = useStore((s) => s.updateFileContent);
  const saveFile = useStore((s) => s.saveFile);
  const reviewChange = useStore((s) => s.reviewChange);
  const refreshChanges = useStore((s) => s.refreshChanges);
  const setScreen = useStore((s) => s.setScreen);
  const layout = useStore((s) => s.layout);
  const patchLayout = useStore((s) => s.patchLayout);

  const [view, setView] = useState<CentreView>('editor');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [reviewPath, setReviewPath] = useState<string | null>(null);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const file = openFiles.find((f) => f.path === activeFile) ?? null;
  const change = changes.find((c) => c.path === (reviewPath ?? activeFile)) ?? changes[0] ?? null;

  useEffect(() => {
    if (changes.length && view === 'editor' && !openFiles.length) setView('diff');
  }, [changes.length, openFiles.length, view]);

  const runSearch = useCallback(
    async (value: string) => {
      if (!workspaceId || value.trim().length < 2) {
        setSearchResults(null);
        return;
      }
      const { results } = await api.search(workspaceId, value);
      setSearchResults(results);
    },
    [workspaceId],
  );

  if (!workspace) {
    return (
      <div className="app__screen">
        <div className="app__screen-body">
          <EmptyState
            icon={<IconFolder />}
            title="No workspace open"
            description="A workspace is the directory an agent reads and changes. Open a recent one, or create a new one from Home."
            action={
              <Button variant="primary" onClick={() => setScreen('home')}>
                Go to Home
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ws">
      <SplitPane
        direction="horizontal"
        sizes={[layout.columns[0], 1 - layout.columns[0]]}
        minSizes={[0.12, 0.4]}
        onSizesChange={([a]) => patchLayout({ columns: [a, layout.columns[1], layout.columns[2]] })}
      >
        <div className="ws__files">
          <div className="ws__files-header">
            <SearchField
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                void runSearch(next);
              }}
              onClear={() => {
                setQuery('');
                setSearchResults(null);
              }}
              placeholder="Search files"
              aria-label="Search the workspace"
              size="sm"
            />
          </div>
          <div className="ws__files-body mrd-scroll">
            {searchResults ? (
              <SearchResults results={searchResults} onOpen={(p) => void openFile(p)} />
            ) : tree ? (
              <FileTree node={tree} onOpen={(p) => void openFile(p)} active={activeFile} changes={changes} depth={0} />
            ) : (
              <div className="mrd-caption" style={{ padding: 'var(--space-3)' }}>
                Loading…
              </div>
            )}
          </div>
        </div>

        <div className="ws__centre">
          <div className="ws__tabs">
            <div className="ws__tabstrip mrd-scroll-x" role="tablist" aria-label="Open files">
              {openFiles.map((f) => (
                <div
                  key={f.path}
                  role="tab"
                  aria-selected={activeFile === f.path}
                  tabIndex={activeFile === f.path ? 0 : -1}
                  className={`ws__tab${activeFile === f.path ? ' ws__tab--active' : ''} mrd-focus-ring`}
                  onClick={() => {
                    setActiveFile(f.path);
                    setView('editor');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveFile(f.path);
                      setView('editor');
                    }
                  }}
                >
                  <span className="mrd-truncate">{f.path.split('/').pop()}</span>
                  {f.dirty && <span className="ws__dirty" aria-label="Unsaved changes" />}
                  <IconButton
                    label={`Close ${f.path}`}
                    icon={<IconClose />}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(f.path);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mrd-spacer" />
            <SegmentedControl
              size="sm"
              value={view}
              onChange={(v) => setView(v as CentreView)}
              options={[
                { value: 'editor', label: 'Editor' },
                { value: 'diff', label: changes.length ? `Diff (${changes.length})` : 'Diff' },
              ]}
            />
          </div>

          <div className="ws__editor">
            {view === 'diff' ? (
              <DiffPane
                changes={changes}
                selected={change}
                onSelect={setReviewPath}
                onAccept={(p) => void reviewChange('accept', p)}
                onReject={(p) => void reviewChange('reject', p)}
                onRefresh={() => void refreshChanges()}
              />
            ) : file ? (
              <CodeEditor
                value={file.content}
                path={file.path}
                onChange={(next) => updateFileContent(file.path, next)}
                onSave={() => void saveFile(file.path)}
              />
            ) : (
              <EmptyState
                icon={<IconFile />}
                title="No file open"
                description="Choose a file from the tree, or ask the assistant to make a change and review the diff here."
              />
            )}
          </div>
        </div>
      </SplitPane>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FileTree({
  node,
  onOpen,
  active,
  changes,
  depth,
}: {
  node: FileNode;
  onOpen: (path: string) => void;
  active: string | null;
  changes: FileChange[];
  depth: number;
}): React.JSX.Element {
  // Top levels start open; deeper ones start closed, so a large repository does
  // not render thousands of rows on first paint.
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'file') {
    const change = changes.find((c) => c.path === node.path);
    return (
      <button
        className={`ws__node${active === node.path ? ' ws__node--active' : ''} mrd-focus-ring`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` }}
        onClick={() => onOpen(node.path)}
        aria-current={active === node.path ? 'true' : undefined}
      >
        <IconFile />
        <span className="mrd-truncate">{node.name}</span>
        {change && <span className={`ws__change ws__change--${change.kind}`} title={`${change.kind}: +${change.additions} −${change.deletions}`} />}
      </button>
    );
  }

  return (
    <div>
      {depth > 0 && (
        <button
          className="ws__node mrd-focus-ring"
          style={{ paddingLeft: `calc(var(--space-2) + ${depth - 1} * var(--space-3))` }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <IconChevronDown /> : <IconChevronRight />}
          {open ? <IconFolderOpen /> : <IconFolder />}
          <span className="mrd-truncate">{node.name}</span>
        </button>
      )}
      {open &&
        (node.children ?? []).map((child) => (
          <FileTree key={child.path} node={child} onOpen={onOpen} active={active} changes={changes} depth={depth + 1} />
        ))}
    </div>
  );
}

function SearchResults({
  results,
  onOpen,
}: {
  results: { path: string; line: number; text: string }[];
  onOpen: (path: string) => void;
}): React.JSX.Element {
  if (!results.length) {
    return (
      <div className="mrd-caption" style={{ padding: 'var(--space-3)' }}>
        No matches.
      </div>
    );
  }
  const byFile = new Map<string, typeof results>();
  for (const r of results) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r]);

  return (
    <div>
      {[...byFile.entries()].map(([path, hits]) => (
        <div key={path} className="ws__search-group">
          <button className="ws__node mrd-focus-ring" onClick={() => onOpen(path)}>
            <IconFile />
            <span className="mrd-truncate">{path}</span>
            <span className="mrd-caption mrd-numeric">{hits.length}</span>
          </button>
          {hits.slice(0, 5).map((h) => (
            <div key={`${h.path}:${h.line}`} className="ws__search-hit mrd-code mrd-truncate">
              <span className="mrd-caption mrd-numeric">{h.line}</span> {h.text.trim()}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DiffPane({
  changes,
  selected,
  onSelect,
  onAccept,
  onReject,
  onRefresh,
}: {
  changes: FileChange[];
  selected: FileChange | null;
  onSelect: (path: string) => void;
  onAccept: (path?: string) => void;
  onReject: (path?: string) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const pending = useMemo(() => changes.filter((c) => c.state === 'pending'), [changes]);

  if (!changes.length) {
    return (
      <EmptyState
        icon={<IconFile />}
        title="No pending changes"
        description="When an agent edits files, every change appears here with its diff. Nothing is permanent until you accept it."
        action={
          <Button variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        }
      />
    );
  }

  return (
    <div className="ws__diff">
      <div className="ws__diff-list mrd-scroll">
        <List>
          {changes.map((c) => (
            <ListRow
              key={c.path}
              value={c.path}
              selected={selected?.path === c.path}
              onClick={() => onSelect(c.path)}
              icon={<span className={`ws__change ws__change--${c.kind}`} />}
              secondary={c.path}
              trailing={
                <span className="mrd-caption mrd-numeric">
                  +{c.additions} −{c.deletions}
                </span>
              }
            >
              {c.path.split('/').pop() ?? c.path}
            </ListRow>
          ))}
        </List>
      </div>
      <div className="ws__diff-view">
        <div className="ws__diff-actions">
          <StatusChip
            status={pending.length ? 'busy' : 'ready'}
            label={pending.length ? `${pending.length} awaiting review` : 'All reviewed'}
            size="sm"
          />
          <div className="mrd-spacer" />
          <Button size="sm" variant="tertiary" onClick={() => onReject()}>
            Reject all
          </Button>
          <Button size="sm" variant="primary" onClick={() => onAccept()}>
            Accept all
          </Button>
        </div>
        {selected ? (
          <DiffViewer
            before={selected.before}
            after={selected.after}
            path={selected.path}
            onAcceptFile={() => onAccept(selected.path)}
            onRejectFile={() => onReject(selected.path)}
          />
        ) : (
          <EmptyState title="Select a change" description="Choose a file on the left to review its diff." />
        )}
      </div>
    </div>
  );
}
