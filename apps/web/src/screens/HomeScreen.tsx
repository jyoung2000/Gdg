import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Stack,
  StatusChip,
  Stars,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconServer,
  IconSparkle,
} from '@meridian/ui';
import { formatCost, formatRelative } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The landing surface: recent workspaces, what the instance can currently do,
 * and the shortest path to doing something. A first-run instance has no
 * providers configured, so the primary action here is connecting one rather
 * than a disabled prompt box.
 */
export function HomeScreen(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
  const setScreen = useStore((s) => s.setScreen);
  const info = useStore((s) => s.info);
  const tasks = useStore((s) => s.tasks);
  const [creating, setCreating] = useState(false);
  const [usage, setUsage] = useState<{ requests: number; cost: number; tokens: number } | null>(null);

  useEffect(() => {
    void api
      .usage(7)
      .then((r) => setUsage(r.summary.totals))
      .catch(() => undefined);
  }, []);

  const hasProviders = (info?.counts.providersConfigured ?? 0) > 0;
  const hasModels = (info?.counts.models ?? 0) > 0;

  return (
    <Screen
      title="Meridian"
      subtitle="One interface for every model, provider and modality."
      actions={
        <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
          New workspace
        </Button>
      }
    >
      {!hasModels && (
        <Card>
          <Stack direction="column" gap={3}>
            <Stack direction="row" gap={2} align="center">
              <IconServer />
              <span className="mrd-section-title">
                {hasProviders ? 'No models discovered yet' : 'No providers configured yet'}
              </span>
            </Stack>
            <p className="mrd-secondary">
              {hasProviders
                ? 'Credentials are configured but no model listing has come back yet. Run discovery to fetch what each provider can serve.'
                : 'Meridian routes to providers you connect. Add a key in Providers, or start a local model server — Ollama, vLLM, llama.cpp or LM Studio — and it will be found automatically.'}
            </p>
            <Stack direction="row" gap={2}>
              <Button variant="primary" onClick={() => setScreen('providers')}>
                {hasProviders ? 'Open providers' : 'Connect a provider'}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await api.discover();
                  await useStore.getState().refreshModels();
                  await useStore.getState().refreshProviders();
                }}
              >
                Run discovery
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}

      <section>
        <h2 className="mrd-panel-title">Recent workspaces</h2>
        {workspaces.length === 0 ? (
          <EmptyState
            icon={<IconFolder />}
            title="No workspaces yet"
            description="A workspace is a directory an agent can read and change. Create an empty one, or clone a repository into it."
            action={
              <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
                Create a workspace
              </Button>
            }
          />
        ) : (
          <div className="app__grid">
            {workspaces.slice(0, 9).map((w) => (
              <Card
                key={w.id}
                onClick={() => {
                  void openWorkspace(w.id);
                  setScreen('workspace');
                }}
              >
                <Stack direction="column" gap={2}>
                  <Stack direction="row" gap={2} align="center">
                    {w.repoUrl ? <IconGitBranch /> : <IconFolder />}
                    <span className="mrd-section-title mrd-truncate">{w.name}</span>
                  </Stack>
                  <span className="mrd-caption mrd-truncate">{w.repoUrl ?? w.path}</span>
                  <Stack direction="row" gap={2} align="center">
                    <StatusChip status="unknown" label={w.defaultMode} size="sm" />
                    <span className="mrd-caption">
                      {w.lastOpenedAt ? formatRelative(w.lastOpenedAt, Date.now()) : 'never opened'}
                    </span>
                  </Stack>
                </Stack>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mrd-panel-title">This instance</h2>
        <div className="app__grid">
          <Card>
            <Stack direction="column" gap={1}>
              <span className="mrd-caption">Models routable</span>
              <span className="mrd-title mrd-numeric">{info?.counts.models ?? 0}</span>
              <span className="mrd-caption">
                across {info?.counts.providersConfigured ?? 0} configured provider
                {info?.counts.providersConfigured === 1 ? '' : 's'}
              </span>
            </Stack>
          </Card>
          <Card>
            <Stack direction="column" gap={1}>
              <span className="mrd-caption">Spend, last 7 days</span>
              <span className="mrd-title mrd-numeric">{usage ? formatCost(usage.cost) : '—'}</span>
              <span className="mrd-caption">
                {usage ? `${usage.requests} requests · ${usage.tokens.toLocaleString()} tokens` : 'no calls yet'}
              </span>
            </Stack>
          </Card>
          <Card>
            <Stack direction="column" gap={1}>
              <span className="mrd-caption">Paid routing</span>
              <span className="mrd-title">{info?.allowPaid ? 'Enabled' : 'Off'}</span>
              <span className="mrd-caption">
                {info?.allowPaid
                  ? 'Requests may spend money when they ask for it.'
                  : 'Nothing can spend money until you turn this on.'}
              </span>
            </Stack>
          </Card>
          <Card>
            <Stack direction="column" gap={1}>
              <span className="mrd-caption">Command execution</span>
              <span className="mrd-title">{info?.sandbox.kind ?? '—'}</span>
              {/* The summary, not the full note: this line is narrow, and
                  truncating the note would cut off exactly the clause that
                  says the process sandbox is not a security boundary. */}
              <span className="mrd-caption">{info?.sandbox.degradedReason ?? info?.sandbox.isolationSummary}</span>
            </Stack>
          </Card>
        </div>
      </section>

      {tasks.length > 0 && (
        <section>
          <h2 className="mrd-panel-title">Recent tasks</h2>
          <Stack direction="column" gap={2}>
            {tasks.slice(0, 5).map((t) => (
              <Card key={t.id} onClick={() => setScreen('tasks')}>
                <Stack direction="row" gap={3} align="center">
                  <StatusChip
                    status={t.status === 'completed' ? 'ready' : t.status === 'running' ? 'busy' : t.status === 'failed' ? 'degraded' : 'unknown'}
                    label={t.status}
                    size="sm"
                  />
                  <span className="mrd-truncate">{t.title}</span>
                  <div className="mrd-spacer" />
                  <span className="mrd-caption mrd-numeric">{formatCost(t.usage.cost)}</span>
                </Stack>
              </Card>
            ))}
          </Stack>
        </section>
      )}

      <NewWorkspaceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await refreshWorkspaces();
          await openWorkspace(id);
          setScreen('workspace');
        }}
      />
    </Screen>
  );
}

function NewWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [privacyMode, setPrivacyMode] = useState('TRUSTED_ONLY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWorkspace({ name: name.trim() || undefined, repoUrl: repoUrl.trim() || undefined, privacyMode });
      if (res.clone && !res.clone.ok) {
        // The workspace exists; the clone did not. Say so rather than pretending.
        toast({ level: 'warn', message: 'Workspace created, but the clone failed', detail: res.clone.detail });
      }
      await onCreated(res.workspace.id);
      setName('');
      setRepoUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="New workspace" size="md">
      <Stack direction="column" gap={4}>
        <Field label="Name" description="What you will recognise it by.">
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="my-project" autoFocus />
        </Field>
        <Field label="Repository" description="Optional. Meridian clones it into the workspace. Nothing is pushed back without you asking.">
          <Input value={repoUrl} onChange={(e) => setRepoUrl(e.currentTarget.value)} placeholder="https://github.com/owner/repo.git" />
        </Field>
        <Field
          label="Privacy"
          description="Controls which providers this workspace's code may be sent to. Strict local never leaves the machine."
        >
          <Select value={privacyMode} onChange={(e) => setPrivacyMode(e.currentTarget.value)}>
            <option value="STRICT_LOCAL">Strict local — nothing leaves this machine</option>
            <option value="TRUSTED_ONLY">Trusted providers only</option>
            <option value="FREE_PROVIDERS">Include free providers</option>
            <option value="ANY_PROVIDER">Any configured provider</option>
          </Select>
        </Field>
        {error && <p className="mrd-secondary">{error}</p>}
        <Stack direction="row" gap={2} justify="end">
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}
