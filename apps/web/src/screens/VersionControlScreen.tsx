import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconGitBranch,
  IconGitCommit,
  IconGitPullRequest,
  Input,
  Select,
  Stack,
  StatusChip,
  TextArea,
} from '@meridian/ui';
import { api, type GitStatusView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Version control for the active workspace.
 *
 * The workspace is the boundary: this screen only ever talks to
 * /api/git/<workspaceId>, and credentials for push/pull are whatever the
 * gateway host already has — so a push that is not authenticated shows the
 * real git error rather than a Meridian-invented one.
 */
export function VersionControlScreen(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? '');
  const toast = useStore((s) => s.toast);

  const [status, setStatus] = useState<GitStatusView | null>(null);
  const [branches, setBranches] = useState<{ current: string | null; local: string[]; remote: string[] }>({ current: null, local: [], remote: [] });
  const [commits, setCommits] = useState<{ hash: string; subject: string; author: string; at: string }[]>([]);
  const [gh, setGh] = useState<{ installed: boolean; authenticated: boolean; detail: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [prTitle, setPrTitle] = useState('');

  useEffect(() => {
    if (activeWorkspaceId && !workspaceId) setWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId, workspaceId]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [s, b, l] = await Promise.all([api.gitStatus(workspaceId), api.gitBranches(workspaceId), api.gitLog(workspaceId, 20)]);
      setStatus(s.status);
      setBranches(b.branches);
      setCommits(l.commits);
    } catch (e) {
      toast({ level: 'error', message: 'Could not read git state', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, toast]);

  useEffect(() => {
    void refresh();
    void api.ghInfo().then((r) => setGh(r.gh)).catch(() => setGh(null));
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      toast({ level: 'success', message: label });
    } catch (e) {
      toast({ level: 'error', message: `${label} failed`, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!workspaces.length) {
    return (
      <Screen title="Version Control" subtitle="Git for your workspaces">
        <EmptyState icon={<IconGitBranch />} title="No workspaces yet" description="Create or open a workspace, then manage its branches and commits here." />
      </Screen>
    );
  }

  const changeCount = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0;

  return (
    <Screen
      title="Version Control"
      subtitle="Branches, commits and remotes for the selected workspace"
      actions={
        <>
          <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace">
            <option value="">Select a workspace…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={!workspaceId || loading}>
            Refresh
          </Button>
        </>
      }
    >
      {!workspaceId ? (
        <EmptyState icon={<IconGitBranch />} title="Select a workspace" description="Choose a workspace above to see its git state." />
      ) : !status?.isRepo ? (
        <Card>
          <Stack gap={3}>
            <h2 className="mrd-heading">Not a git repository</h2>
            <p className="mrd-secondary">This workspace has no git repository yet. Initialize one from the terminal, or clone a repository into it.</p>
          </Stack>
        </Card>
      ) : (
        <Stack gap={6}>
          <Card>
            <div className="mrd-hstack" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
              <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                <IconGitBranch />
                <strong>{status.branch ?? '(detached)'}</strong>
                {status.upstream && <Badge>{status.upstream}</Badge>}
                {status.ahead > 0 && <StatusChip status="busy" size="sm" label={`↑${status.ahead}`} />}
                {status.behind > 0 && <StatusChip status="degraded" size="sm" label={`↓${status.behind}`} />}
                <StatusChip status={changeCount ? 'busy' : 'ready'} size="sm" label={changeCount ? `${changeCount} change(s)` : 'clean'} />
              </div>
              <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('Fetched', () => api.gitFetch(workspaceId))}>
                  Fetch
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || status.behind === 0} onClick={() => void run('Pulled', () => api.gitPull(workspaceId))}>
                  Pull
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run('Pushed', () => api.gitPush(workspaceId, !status.upstream))}
                >
                  {status.upstream ? 'Push' : 'Push (set upstream)'}
                </Button>
              </div>
            </div>
            {status.remoteUrl && <p className="mrd-caption" style={{ marginTop: 'var(--space-2)' }}>origin: {status.remoteUrl}</p>}
          </Card>

          <div className="mrd-grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
            <Card>
              <Stack gap={4}>
                <h2 className="mrd-heading">Branches</h2>
                <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                  <Input
                    placeholder="new-branch-name"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    size="sm"
                    disabled={busy || !newBranch.trim()}
                    onClick={() =>
                      void run(`Created ${newBranch}`, async () => {
                        await api.gitCreateBranch(workspaceId, newBranch.trim());
                        setNewBranch('');
                      })
                    }
                  >
                    Create & switch
                  </Button>
                </div>
                <Stack gap={2}>
                  {branches.local.map((b) => (
                    <div key={b} className="mrd-hstack" style={{ justifyContent: 'space-between' }}>
                      <span className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <IconGitBranch />
                        <span className={b === branches.current ? 'mrd-strong' : ''}>{b}</span>
                        {b === branches.current && <Badge variant="accent">current</Badge>}
                      </span>
                      {b !== branches.current && (
                        <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void run(`Switched to ${b}`, () => api.gitSwitch(workspaceId, b))}>
                          Switch
                        </Button>
                      )}
                    </div>
                  ))}
                </Stack>
                {branches.remote.length > 0 && (
                  <details>
                    <summary className="mrd-caption">{branches.remote.length} remote branch(es)</summary>
                    <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                      {branches.remote.map((b) => (
                        <span key={b} className="mrd-caption mrd-code">
                          {b}
                        </span>
                      ))}
                    </Stack>
                  </details>
                )}
              </Stack>
            </Card>

            <Card>
              <Stack gap={4}>
                <h2 className="mrd-heading">Changes & commit</h2>
                {changeCount === 0 ? (
                  <p className="mrd-secondary">Working tree clean.</p>
                ) : (
                  <Stack gap={2} style={{ maxHeight: 160, overflow: 'auto' }}>
                    {status.staged.map((c) => (
                      <span key={`s${c.path}`} className="mrd-caption">
                        <Badge variant="success">{c.state}</Badge> {c.path}
                      </span>
                    ))}
                    {status.unstaged.map((c) => (
                      <span key={`u${c.path}`} className="mrd-caption">
                        <Badge>{c.state}</Badge> {c.path}
                      </span>
                    ))}
                    {status.untracked.map((c) => (
                      <span key={`n${c}`} className="mrd-caption">
                        <Badge variant="warning">?</Badge> {c}
                      </span>
                    ))}
                  </Stack>
                )}
                <Field label="Commit message" description="Stages all changes (git add -A) and commits">
                  <TextArea rows={2} value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Describe your change" />
                </Field>
                <Button
                  size="sm"
                  icon={<IconGitCommit />}
                  disabled={busy || !commitMessage.trim() || changeCount === 0}
                  onClick={() =>
                    void run('Committed', async () => {
                      await api.gitCommit(workspaceId, commitMessage.trim());
                      setCommitMessage('');
                    })
                  }
                >
                  Commit all changes
                </Button>
              </Stack>
            </Card>
          </div>

          <Card>
            <Stack gap={4}>
              <div className="mrd-hstack" style={{ justifyContent: 'space-between' }}>
                <h2 className="mrd-heading">Pull request</h2>
                <StatusChip
                  status={gh?.installed && gh.authenticated ? 'ready' : 'offline'}
                  size="sm"
                  label={gh?.installed ? (gh.authenticated ? 'gh ready' : 'gh not authenticated') : 'gh not installed'}
                />
              </div>
              {gh?.installed && gh.authenticated ? (
                <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                  <Input placeholder="PR title" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    icon={<IconGitPullRequest />}
                    disabled={busy || !prTitle.trim()}
                    onClick={() =>
                      void run('PR created', async () => {
                        const { url } = await api.gitCreatePr(workspaceId, { title: prTitle.trim() });
                        setPrTitle('');
                        if (url) toast({ level: 'success', message: 'Pull request opened', detail: url });
                      })
                    }
                  >
                    Create PR
                  </Button>
                </div>
              ) : (
                <p className="mrd-secondary">{gh?.detail ?? 'The GitHub CLI is not available on the gateway host. Install and authenticate gh, or add the GitHub MCP server from the MCP screen.'}</p>
              )}
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <h2 className="mrd-heading">Recent commits</h2>
              {commits.length === 0 ? (
                <p className="mrd-secondary">No commits yet.</p>
              ) : (
                <Stack gap={2}>
                  {commits.map((c) => (
                    <div key={c.hash} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                      <span className="mrd-code mrd-caption">{c.hash}</span>
                      <span className="mrd-truncate">{c.subject}</span>
                      <span className="mrd-caption mrd-secondary" style={{ marginLeft: 'auto' }}>
                        {c.author}
                      </span>
                    </div>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        </Stack>
      )}
    </Screen>
  );
}
