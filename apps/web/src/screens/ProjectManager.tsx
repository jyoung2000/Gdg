import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, Input, Select, Stack, TextArea } from '@meridian/ui';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

/**
 * Create and curate projects — the shared implementation behind both the
 * Projects tab and the composer's quick "Manage projects" dialog.
 *
 * A project is a workspace: a real folder on disk with a `MERIDIAN.md` at its
 * root holding the standing instructions. Everything here goes through the
 * ordinary workspace API, so a project made here is the same object the
 * Workspace screen edits and a task runs against — no parallel store, no
 * pretend state.
 */

const INSTRUCTIONS_FILE = 'MERIDIAN.md';

function flattenFiles(tree: unknown): string[] {
  const out: string[] = [];
  const walk = (n: { path?: string; type?: string; children?: unknown[] } | null | undefined): void => {
    if (!n) return;
    if (n.type === 'file' && n.path) out.push(n.path);
    for (const c of (n.children ?? []) as { path?: string; type?: string; children?: unknown[] }[]) walk(c);
  };
  walk(tree as never);
  return out.filter((f) => f !== INSTRUCTIONS_FILE).sort();
}

export function ProjectManager({
  activeProject,
  onActivate,
}: {
  /** The currently active project id, so it can be shown as selected. */
  activeProject: string | null;
  /** Called when the user chooses to use a project (or clears it with null). */
  onActivate: (id: string | null) => void;
}): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces);
  const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
  const toast = useStore((s) => s.toast);

  const [selected, setSelected] = useState<string | null>(activeProject ?? workspaces[0]?.id ?? null);
  const [instructions, setInstructions] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  // If projects load in after mount, land on the active or first one.
  useEffect(() => {
    setSelected((cur) => cur ?? activeProject ?? workspaces[0]?.id ?? null);
  }, [activeProject, workspaces]);

  // Load the selected project's instructions and file list.
  useEffect(() => {
    if (!selected) {
      setInstructions('');
      setFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const detail = await api.tree(selected, '', 6).catch(() => null);
      const instr = await api
        .readFile(selected, INSTRUCTIONS_FILE)
        .then((r) => r.content)
        .catch(() => '');
      if (!cancelled) {
        setFiles(flattenFiles(detail?.tree));
        setInstructions(instr);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const reloadFiles = async (id: string): Promise<void> => {
    const detail = await api.tree(id, '', 6).catch(() => null);
    setFiles(flattenFiles(detail?.tree));
  };

  const create = async (): Promise<void> => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const { workspace } = await api.createWorkspace({ name: newName.trim() });
      setNewName('');
      await refreshWorkspaces();
      setSelected(workspace.id);
      toast({ level: 'success', message: `Project "${workspace.name}" created` });
    } catch (e) {
      toast({ level: 'error', message: 'Could not create the project', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveInstructions = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.writeFile(selected, INSTRUCTIONS_FILE, instructions);
      toast({ level: 'success', message: 'Instructions saved to the project' });
    } catch (e) {
      toast({ level: 'error', message: 'Could not save instructions', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const uploadText = async (fileList: FileList | null): Promise<void> => {
    if (!selected || !fileList?.length) return;
    setBusy(true);
    let added = 0;
    try {
      for (const file of [...fileList]) {
        if (file.size > 512 * 1024) {
          toast({ level: 'warn', message: `Skipped ${file.name}`, detail: 'larger than 512 KB' });
          continue;
        }
        const text = await file.text().catch(() => null);
        if (text == null) {
          toast({ level: 'warn', message: `Skipped ${file.name}`, detail: 'not a readable text file' });
          continue;
        }
        await api.writeFile(selected, file.name.replace(/[^A-Za-z0-9._-]/g, '_'), text);
        added += 1;
      }
      if (added) {
        await reloadFiles(selected);
        toast({ level: 'success', message: `Added ${added} file(s) to the project` });
      }
    } finally {
      setBusy(false);
    }
  };

  const isActive = selected !== null && selected === activeProject;

  return (
    <Stack direction="column" gap={4}>
      <Stack direction="column" gap={2}>
        <strong>Projects give the AI shared context</strong>
        <span className="mrd-secondary">
          A project is a folder of files plus standing instructions. Whichever project is active, every message in the
          conversation can reference its files, and its instructions always apply — the same idea as a project in other
          assistants, backed by a real workspace folder here.
        </span>
      </Stack>

      <Stack direction="row" gap={2} align="end" wrap>
        <Field label="New project" description="Creates a workspace folder you can fill with files.">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Q3 launch" />
        </Field>
        <Button variant="secondary" onClick={() => void create()} disabled={busy || !newName.trim()}>
          Create
        </Button>
      </Stack>

      {workspaces.length > 0 ? (
        <Field label="Project" description="The one whose files and instructions become context.">
          <Select value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <EmptyState title="No projects yet" description="Create one above to give the AI a folder of files to work from." />
      )}

      {selected ? (
        <>
          <Field
            label="Special instructions"
            description="Saved as MERIDIAN.md in the project. Prepended to every message while this project is active."
          >
            <TextArea
              rows={6}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="How should the AI work in this project? What should it always keep in mind?"
            />
          </Field>
          <Stack direction="row" gap={2} wrap>
            <Button variant="secondary" onClick={() => void saveInstructions()} disabled={busy}>
              Save instructions
            </Button>
            <label className="mrd-button mrd-button--secondary mrd-button--md" style={{ cursor: 'pointer' }}>
              Add files
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void uploadText(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <Button variant="primary" onClick={() => onActivate(selected)} disabled={isActive}>
              {isActive ? 'Active in chat' : 'Use in chat'}
            </Button>
            {activeProject ? (
              <Button variant="tertiary" onClick={() => onActivate(null)}>
                Clear active project
              </Button>
            ) : null}
          </Stack>

          <Field
            label={`Files in this project (${files.length})`}
            description="Text files here are shared with the AI as project knowledge."
          >
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {files.length ? (
                <Stack direction="column" gap={1}>
                  {files.map((f) => (
                    <span key={f} className="mrd-caption mrd-numeric">
                      {f}
                    </span>
                  ))}
                </Stack>
              ) : (
                <span className="mrd-secondary">Empty. Add files above.</span>
              )}
            </div>
          </Field>
        </>
      ) : null}
    </Stack>
  );
}
