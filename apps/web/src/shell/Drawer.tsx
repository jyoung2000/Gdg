import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Input, StatusChip, Table, Terminal, IconTerminal, type TableColumn } from '@meridian/ui';
import { formatCost, formatRelative, type UsageRecord } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

type Tab = 'terminal' | 'tasks' | 'logs' | 'git' | 'usage';

const TABS: { id: Tab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'git', label: 'Git' },
  { id: 'logs', label: 'Activity' },
  { id: 'usage', label: 'Usage' },
];

/**
 * The bottom drawer: terminal, task queue, git, activity and usage.
 *
 * The terminal is a real sandboxed shell rather than a log view, which is why
 * the isolation posture is stated in the header — a user running `rm -rf` needs
 * to know whether they are inside a container or on the host.
 */
export function Drawer(): React.JSX.Element {
  const layout = useStore((s) => s.layout);
  const patchLayout = useStore((s) => s.patchLayout);
  const tab = layout.drawerTab;

  return (
    <section className="app__drawer drawer" style={{ height: 'var(--drawer-height)' }} aria-label="Terminal and activity">
      <div className="drawer__tabs" role="tablist" aria-label="Drawer sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`drawer__tab${tab === t.id ? ' drawer__tab--active' : ''} mrd-focus-ring`}
            onClick={() => patchLayout({ drawerTab: t.id })}
          >
            {t.label}
          </button>
        ))}
        <div className="mrd-spacer" />
        <Button size="sm" variant="tertiary" onClick={() => patchLayout({ drawerOpen: false })}>
          Hide
        </Button>
      </div>
      <div className="drawer__body">
        {tab === 'terminal' && <TerminalPane />}
        {tab === 'tasks' && <TasksPane />}
        {tab === 'git' && <GitPane />}
        {tab === 'logs' && <ActivityPane />}
        {tab === 'usage' && <UsagePane />}
      </div>
    </section>
  );
}

function TerminalPane(): React.JSX.Element {
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const info = useStore((s) => s.info);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const writeRef = useRef<((text: string) => void) | null>(null);
  const printedIntro = useRef(false);

  useEffect(() => {
    if (printedIntro.current || !writeRef.current || !info) return;
    printedIntro.current = true;
    writeRef.current(`Meridian sandbox (${info.sandbox.kind})\r\n${info.sandbox.isolation}\r\n\r\n`);
  }, [info]);

  const run = useCallback(async () => {
    if (!workspaceId || !command.trim() || busy) return;
    setBusy(true);
    writeRef.current?.(`\x1b[2m$\x1b[0m ${command}\r\n`);
    try {
      const res = await api.exec(workspaceId, command);
      if (res.stdout) writeRef.current?.(`${res.stdout.replace(/\n/g, '\r\n')}\r\n`);
      if (res.stderr) writeRef.current?.(`\x1b[31m${res.stderr.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      writeRef.current?.(`\x1b[2mexit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}\x1b[0m\r\n\r\n`);
    } catch (e) {
      writeRef.current?.(`\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n\r\n`);
    } finally {
      setBusy(false);
      setCommand('');
    }
  }, [busy, command, workspaceId]);

  if (!workspaceId) {
    return <div className="drawer__console mrd-secondary">Open a workspace to use the terminal.</div>;
  }

  return (
    <div className="drawer__terminal" style={{ display: 'flex', flexDirection: 'column' }}>
      <Terminal writeRef={writeRef} />
      <form
        className="drawer__prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span className="mrd-code mrd-secondary">$</span>
        <Input
          value={command}
          onChange={(e) => setCommand(e.currentTarget.value)}
          placeholder="Run a command in the sandbox"
          aria-label="Sandbox command"
          size="sm"
          style={{ flex: 1 }}
          disabled={busy}
        />
        <Button type="submit" size="sm" variant="secondary" loading={busy}>
          Run
        </Button>
      </form>
    </div>
  );
}

function TasksPane(): React.JSX.Element {
  const tasks = useStore((s) => s.tasks);
  const openTask = useStore((s) => s.openTask);
  const cancelTask = useStore((s) => s.cancelTask);

  const columns: TableColumn<(typeof tasks)[number]>[] = [
    { key: 'title', header: 'Task', render: (t) => <span className="mrd-truncate">{t.title}</span> },
    { key: 'status', header: 'Status', width: '120px', render: (t) => <StatusChip status={t.status === 'completed' ? 'ready' : t.status === 'running' ? 'busy' : t.status === 'failed' ? 'degraded' : 'unknown'} label={t.status} size="sm" /> },
    { key: 'lane', header: 'Lane', width: '110px', render: (t) => t.lane ?? '—' },
    { key: 'cost', header: 'Cost', width: '90px', align: 'end', render: (t) => <span className="mrd-numeric">{formatCost(t.usage.cost)}</span> },
    { key: 'created', header: 'Started', width: '110px', render: (t) => formatRelative(t.createdAt, Date.now()) },
    {
      key: 'actions',
      header: '',
      width: '140px',
      align: 'end',
      render: (t) => (
        <>
          <Button size="sm" variant="tertiary" onClick={() => void openTask(t.id)}>
            Open
          </Button>
          {t.running && (
            <Button size="sm" variant="tertiary" onClick={() => void cancelTask(t.id)}>
              Stop
            </Button>
          )}
        </>
      ),
    },
  ];

  return <Table columns={columns} rows={tasks} rowKey={(t) => t.id} empty="No tasks yet." />;
}

function GitPane(): React.JSX.Element {
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (operation: string, extra: Record<string, string> = {}): Promise<void> => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const res = await api.git(workspaceId, operation, extra);
      setOutput(`${res.stdout}${res.stderr}${res.note ? `\n${res.note}` : ''}`.trim() || `exit ${res.exitCode}`);
    } catch (e) {
      setOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) return <div className="drawer__console mrd-secondary">Open a workspace to use git.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="drawer__prompt" style={{ borderTop: 'none', borderBottom: '1px solid var(--color-separator)' }}>
        <Button size="sm" variant="secondary" onClick={() => void run('status')} loading={busy}>
          Status
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void run('diff')}>
          Diff
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void run('log')}>
          Log
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void run('commit', { message: 'Changes from Meridian' })}>
          Commit
        </Button>
        <span className="mrd-caption">Meridian never pushes on your behalf.</span>
      </div>
      <pre className="drawer__console">{output || 'Run a git command.'}</pre>
    </div>
  );
}

function ActivityPane(): React.JSX.Element {
  const [entries, setEntries] = useState<{ id: string; at: number; actor: string; action: string; target: string | null }[]>([]);

  useEffect(() => {
    void api
      .audit()
      .then((r) => setEntries(r.entries))
      .catch(() => undefined);
  }, []);

  const columns: TableColumn<(typeof entries)[number]>[] = [
    { key: 'at', header: 'When', width: '110px', render: (e) => formatRelative(e.at, Date.now()) },
    { key: 'action', header: 'Action', render: (e) => <Badge variant="neutral">{e.action}</Badge> },
    { key: 'target', header: 'Target', render: (e) => <span className="mrd-truncate mrd-code">{e.target ?? '—'}</span> },
    { key: 'actor', header: 'Actor', width: '160px', render: (e) => <span className="mrd-truncate">{e.actor}</span> },
  ];

  return <Table columns={columns} rows={entries} rowKey={(e) => e.id} empty="No recorded activity yet." />;
}

function UsagePane(): React.JSX.Element {
  const [rows, setRows] = useState<UsageRecord[]>([]);

  useEffect(() => {
    void api
      .usage(1)
      .then((r) => setRows(r.recent))
      .catch(() => undefined);
  }, []);

  const columns: TableColumn<UsageRecord>[] = [
    { key: 'at', header: 'When', width: '110px', render: (r) => formatRelative(r.at, Date.now()) },
    { key: 'model', header: 'Model', render: (r) => <span className="mrd-truncate mrd-code">{r.modelId}</span> },
    { key: 'tokens', header: 'Tokens', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{r.promptTokens + r.completionTokens}</span> },
    { key: 'latency', header: 'Latency', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{(r.latencyMs / 1000).toFixed(1)}s</span> },
    { key: 'cost', header: 'Cost', width: '90px', align: 'end', render: (r) => <span className="mrd-numeric">{formatCost(r.cost)}</span> },
    { key: 'ok', header: '', width: '110px', render: (r) => <StatusChip status={r.success ? 'ready' : 'degraded'} label={r.success ? 'ok' : (r.errorCode ?? 'failed')} size="sm" /> },
  ];

  return <Table columns={columns} rows={rows} rowKey={(r) => r.id} empty="No calls recorded in the last day." />;
}
