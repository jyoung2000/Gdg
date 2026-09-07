import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  IconGlobe,
  IconRefresh,
  IconStop,
  Input,
  Select,
  Stack,
  StatusChip,
} from '@meridian/ui';
import { api, type BrowserEngineView, type BrowserSessionView, type BrowserLogEntry, type PageSnapshotView, type SnapshotElementView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Autonomous browser sessions.
 *
 * Every session here is observable (its log streams below the page) and
 * terminable (Close ends it, Cancel aborts the current operation). Navigation
 * to private/internal addresses is refused by the gateway, and that refusal is
 * shown, not hidden.
 */
export function BrowserScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [engines, setEngines] = useState<BrowserEngineView[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PageSnapshotView | null>(null);
  const [log, setLog] = useState<BrowserLogEntry[]>([]);
  const [url, setUrl] = useState('https://example.com');
  const [engine, setEngine] = useState('auto');
  const [busy, setBusy] = useState(false);

  const refreshSessions = useCallback(async () => {
    const { sessions: s } = await api.browserSessions();
    setSessions(s);
    if (!activeId && s.length) setActiveId(s[0].id);
  }, [activeId]);

  useEffect(() => {
    void api.browserEngines().then((r) => setEngines(r.engines)).catch(() => undefined);
    void refreshSessions();
  }, [refreshSessions]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const { log: entries } = await api.browserSession(id);
      setLog(entries);
    } catch {
      /* session may have closed */
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadSession(activeId);
  }, [activeId, loadSession, snapshot]);

  const create = async () => {
    setBusy(true);
    try {
      const { session } = await api.createBrowserSession({ engine, task: 'interactive' });
      setActiveId(session.id);
      setSnapshot(null);
      await refreshSessions();
      toast({ level: 'success', message: `Session on ${session.engine} started` });
    } catch (e) {
      toast({ level: 'error', message: 'Could not start a browser session', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const act = async (body: Record<string, unknown>) => {
    if (!activeId) return;
    setBusy(true);
    try {
      const res = await api.browserAction(activeId, body);
      if (res.snapshot) setSnapshot(res.snapshot);
      await refreshSessions();
    } catch (e) {
      toast({ level: 'error', message: 'Action failed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const close = async (id: string) => {
    await api.closeBrowserSession(id).catch(() => undefined);
    if (activeId === id) {
      setActiveId(null);
      setSnapshot(null);
    }
    await refreshSessions();
  };

  const chromium = engines.find((e) => e.id === 'chromium');

  return (
    <Screen
      title="Browser"
      subtitle="Real browser sessions an agent — or you — can drive, observe and stop"
      actions={
        <Button variant="secondary" size="sm" icon={<IconRefresh />} onClick={() => void refreshSessions()}>
          Refresh
        </Button>
      }
    >
      <Stack gap={6}>
        <Card>
          <Stack gap={3}>
            <h2 className="mrd-heading">Engines</h2>
            <div className="mrd-hstack" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              {engines.map((e) => (
                <div key={e.id} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                  <StatusChip status={e.available ? 'ready' : 'offline'} size="sm" label={e.id} />
                  <span className="mrd-caption mrd-secondary">{e.available ? e.note : (e.detail ?? 'unavailable')}</span>
                </div>
              ))}
            </div>
          </Stack>
        </Card>

        <Card>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Select value={engine} onChange={(e) => setEngine(e.target.value)} aria-label="Engine">
              <option value="auto">Auto (Chromium)</option>
              <option value="compat">Compatibility (Chromium)</option>
              <option value="fast">Fast (Lightpanda → Chromium)</option>
              {engines.some((e) => e.id === 'cdp' && e.available) && <option value="cdp">Your real browser (CDP)</option>}
            </Select>
            <Button icon={<IconGlobe />} disabled={busy || !chromium?.available} onClick={() => void create()}>
              New session
            </Button>
          </div>
          {!chromium?.available && <p className="mrd-caption" style={{ marginTop: 'var(--space-2)' }}>Chromium is not available: {chromium?.detail}</p>}
        </Card>

        {sessions.length === 0 ? (
          <EmptyState icon={<IconGlobe />} title="No sessions" description="Start a session, then navigate and act on the page. Every action is logged." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)', gap: 'var(--space-4)' }}>
            <Stack gap={4}>
              <Card>
                <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void act({ kind: 'navigate', url });
                    }}
                    placeholder="https://…"
                    style={{ flex: 1 }}
                    disabled={!activeId}
                  />
                  <Button size="sm" disabled={busy || !activeId} onClick={() => void act({ kind: 'navigate', url })}>
                    Go
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy || !activeId} onClick={() => void act({ kind: 'back' })}>
                    Back
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy || !activeId} onClick={() => void act({ kind: 'reload' })}>
                    Reload
                  </Button>
                </div>
              </Card>

              {snapshot && (
                <Card>
                  <Stack gap={3}>
                    <div className="mrd-hstack" style={{ justifyContent: 'space-between' }}>
                      <strong className="mrd-truncate">{snapshot.title || '(untitled)'}</strong>
                      {snapshot.truncated && <Badge variant="warning">truncated</Badge>}
                    </div>
                    <p className="mrd-caption mrd-code mrd-truncate">{snapshot.url}</p>
                    <pre className="mrd-pre" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
                      {snapshot.text.slice(0, 4000)}
                    </pre>
                    <h3 className="mrd-caption">Interactive elements</h3>
                    <div style={{ maxHeight: 240, overflow: 'auto' }}>
                      {snapshot.elements.slice(0, 60).map((el: SnapshotElementView) => (
                        <div key={el.ref} className="mrd-hstack" style={{ gap: 'var(--space-2)', padding: '2px 0' }}>
                          <Badge>{el.ref}</Badge>
                          <span className="mrd-caption mrd-secondary">{el.role}</span>
                          <span className="mrd-truncate" style={{ flex: 1 }}>{el.name}</span>
                          <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void act({ kind: 'click', ref: el.ref })}>
                            Click
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Stack>
                </Card>
              )}
            </Stack>

            <Stack gap={4}>
              <Card>
                <Stack gap={2}>
                  <h3 className="mrd-heading">Sessions</h3>
                  {sessions.map((s) => (
                    <div key={s.id} className={`mrd-hstack${s.id === activeId ? ' mrd-selected' : ''}`} style={{ justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                      <button className="mrd-linklike mrd-truncate" onClick={() => setActiveId(s.id)} style={{ flex: 1, textAlign: 'left' }}>
                        <StatusChip status={s.status === 'ready' ? 'ready' : s.status === 'failed' ? 'offline' : 'busy'} size="sm" label={s.engine} />{' '}
                        {s.title ?? s.task ?? s.id}
                      </button>
                      <IconButton size="sm" variant="tertiary" icon={<IconStop />} label="Close" onClick={() => void close(s.id)} />
                    </div>
                  ))}
                </Stack>
              </Card>

              <Card>
                <h3 className="mrd-heading">Activity log</h3>
                <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 'var(--space-2)' }}>
                  {log.length === 0 ? (
                    <p className="mrd-caption mrd-secondary">No activity yet.</p>
                  ) : (
                    log.slice(-80).map((entry, i) => (
                      <div key={i} className="mrd-caption" style={{ padding: '1px 0' }}>
                        <span className="mrd-secondary">{entry.kind}</span> {entry.message}
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </Stack>
          </div>
        )}
      </Stack>
    </Screen>
  );
}
