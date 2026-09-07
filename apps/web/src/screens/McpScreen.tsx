import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  IconAlertTriangle,
  IconBox,
  IconPlay,
  IconRefresh,
  Input,
  SearchField,
  Stack,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@meridian/ui';
import { api, type McpCatalogEntry, type McpInstallPlan, type McpServerView, type McpToolView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The MCP Control Center.
 *
 * Two rules are visible in the UI, not just the API: installing shows the exact
 * command before it is stored (nothing runs unseen), and a stored secret is
 * never displayed again unless the operator explicitly reveals it.
 */
export function McpScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState('servers');
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [catalog, setCatalog] = useState<{ curated: McpCatalogEntry[]; registry: McpCatalogEntry[]; registryError: string | null }>({
    curated: [],
    registry: [],
    registryError: null,
  });
  const [query, setQuery] = useState('');
  const [installPlan, setInstallPlan] = useState<McpInstallPlan | null>(null);
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  const [playground, setPlayground] = useState<{ server: McpServerView; tools: McpToolView[] } | null>(null);

  const refreshServers = useCallback(async () => {
    const { servers: s } = await api.mcpServers();
    setServers(s);
  }, []);

  const refreshCatalog = useCallback(async (q: string) => {
    try {
      setCatalog(await api.mcpCatalog(q));
    } catch (e) {
      toast({ level: 'error', message: 'Catalog unavailable', detail: e instanceof Error ? e.message : String(e) });
    }
  }, [toast]);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    if (tab === 'catalog') void refreshCatalog(query);
  }, [tab, query, refreshCatalog]);

  const connect = async (id: string) => {
    try {
      const { health } = await api.connectMcp(id);
      toast({ level: health.status === 'running' ? 'success' : 'warn', message: `${health.serverInfo?.name ?? 'server'} ${health.status}`, detail: `${health.tools} tool(s)` });
    } catch (e) {
      toast({ level: 'error', message: 'Connect failed', detail: e instanceof Error ? e.message : String(e) });
    }
    await refreshServers();
  };

  const openPlan = async (entry: McpCatalogEntry, planIndex: number) => {
    try {
      const plan = await api.mcpInstallPlan({ catalogId: entry.id, planIndex, q: query });
      setInstallPlan(plan);
      setInstallEnv({});
    } catch (e) {
      toast({ level: 'error', message: 'Could not build install plan', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const confirmInstall = async () => {
    if (!installPlan) return;
    try {
      const env = Object.entries(installEnv)
        .filter(([, v]) => v)
        .map(([name, value]) => ({ name, value, secret: installPlan.envHints.find((h) => h.name === name)?.secret ?? /key|token|secret/i.test(name) }));
      await api.mcpInstallConfirm({ catalogId: installPlan.entry.id, planIndex: 0, q: query, env });
      toast({ level: 'success', message: `${installPlan.entry.title} added` });
      setInstallPlan(null);
      setTab('servers');
      await refreshServers();
    } catch (e) {
      toast({ level: 'error', message: 'Install failed', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const openPlayground = async (server: McpServerView) => {
    try {
      const { tools } = await api.mcpTools(server.id);
      setPlayground({ server, tools });
    } catch (e) {
      toast({ level: 'error', message: 'Connect the server first', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Screen
      title="MCP"
      subtitle="Install, configure, health-check and try Model Context Protocol servers"
      actions={
        <Button variant="secondary" size="sm" icon={<IconRefresh />} onClick={() => void refreshServers()}>
          Refresh
        </Button>
      }
    >
      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab value="servers">Servers ({servers.length})</Tab>
          <Tab value="catalog">Catalog</Tab>
        </TabList>

        <TabPanel value="servers">
          {servers.length === 0 ? (
            <EmptyState icon={<IconBox />} title="No MCP servers yet" description="Add one from the Catalog tab — the browser-harness, GitHub, filesystem and more are one click away." />
          ) : (
            <Stack gap={4}>
              {servers.map((s) => (
                <Card key={s.id}>
                  <Stack gap={3}>
                    <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                      <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <strong>{s.name}</strong>
                        <Badge>{s.transport}</Badge>
                        <Badge variant={s.permissionLevel === 'privileged' ? 'error' : s.permissionLevel === 'development' ? 'warning' : 'neutral'}>
                          {s.permissionLevel}
                        </Badge>
                        <StatusChip status={s.status === 'running' ? 'ready' : s.status === 'failed' || s.status === 'unhealthy' ? 'offline' : 'unknown'} size="sm" label={s.status} />
                        {s.tools > 0 && <span className="mrd-caption mrd-secondary">{s.tools} tool(s)</span>}
                      </div>
                      <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        {s.status === 'running' ? (
                          <>
                            <Button size="sm" variant="secondary" icon={<IconPlay />} onClick={() => void openPlayground(s)}>
                              Playground
                            </Button>
                            <Button size="sm" variant="tertiary" onClick={() => void api.disconnectMcp(s.id).then(refreshServers)}>
                              Disconnect
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" onClick={() => void connect(s.id)}>
                            Connect
                          </Button>
                        )}
                        <Button size="sm" variant="tertiary" onClick={() => void api.deleteMcpServer(s.id).then(refreshServers)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                    <p className="mrd-caption mrd-code mrd-truncate">
                      {s.command ? `${s.command} ${s.args.join(' ')}` : s.url}
                    </p>
                    {s.health?.error && <p className="mrd-caption" style={{ color: 'var(--color-danger)' }}>{s.health.error}</p>}
                    {(s.warnings ?? []).length > 0 && (
                      <Stack gap={2}>
                        {s.warnings!.map((w) => (
                          <div key={w.kind} className="mrd-hstack" style={{ gap: 'var(--space-2)', color: 'var(--color-warning)' }}>
                            <IconAlertTriangle />
                            <span className="mrd-caption">{w.detail}</span>
                          </div>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Card>
              ))}
            </Stack>
          )}
        </TabPanel>

        <TabPanel value="catalog">
          <Stack gap={4}>
            <SearchField value={query} onValueChange={setQuery} placeholder="Search the official registry and curated servers…" />
            <div>
              <h3 className="mrd-heading">Curated</h3>
              <Stack gap={3} style={{ marginTop: 'var(--space-2)' }}>
                {catalog.curated.map((e) => (
                  <CatalogRow key={e.id} entry={e} onInstall={() => void openPlan(e, 0)} />
                ))}
              </Stack>
            </div>
            <div>
              <h3 className="mrd-heading">Official registry {catalog.registryError && <Badge variant="warning">unreachable</Badge>}</h3>
              {catalog.registryError ? (
                <p className="mrd-caption mrd-secondary">{catalog.registryError}</p>
              ) : (
                <Stack gap={3} style={{ marginTop: 'var(--space-2)' }}>
                  {catalog.registry.slice(0, 20).map((e) => (
                    <CatalogRow key={e.id} entry={e} onInstall={() => void openPlan(e, 0)} />
                  ))}
                </Stack>
              )}
            </div>
          </Stack>
        </TabPanel>
      </Tabs>

      {installPlan && (
        <Dialog
          open
          onOpenChange={(next) => { if (!next) setInstallPlan(null); }}
          title={`Install ${installPlan.entry.title}`}
          description="Review exactly what will run. Nothing has executed yet."
          footer={
            <>
              <Button variant="secondary" onClick={() => setInstallPlan(null)}>
                Cancel
              </Button>
              <Button onClick={() => void confirmInstall()}>Add server</Button>
            </>
          }
        >
          <Stack gap={4}>
            <Card>
              <p className="mrd-caption mrd-secondary">This command will run when the server connects:</p>
              <pre className="mrd-pre mrd-code" style={{ whiteSpace: 'pre-wrap' }}>{installPlan.plan.display}</pre>
              {installPlan.plan.note && <p className="mrd-caption mrd-secondary">{installPlan.plan.note}</p>}
            </Card>
            {installPlan.envHints.length > 0 && (
              <Stack gap={3}>
                <h3 className="mrd-caption">Environment</h3>
                {installPlan.envHints.map((h) => (
                  <Field key={h.name} label={`${h.name}${h.secret ? ' (secret)' : ''}`} description={h.description}>
                    <Input
                      type={h.secret ? 'password' : 'text'}
                      value={installEnv[h.name] ?? ''}
                      onChange={(e) => setInstallEnv((prev) => ({ ...prev, [h.name]: e.target.value }))}
                    />
                  </Field>
                ))}
              </Stack>
            )}
          </Stack>
        </Dialog>
      )}

      {playground && <PlaygroundDialog server={playground.server} tools={playground.tools} onClose={() => setPlayground(null)} />}
    </Screen>
  );
}

function CatalogRow({ entry, onInstall }: { entry: McpCatalogEntry; onInstall: () => void }): React.JSX.Element {
  return (
    <Card>
      <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
            <strong>{entry.title}</strong>
            <Badge>{entry.source === 'curated' ? 'curated' : 'registry'}</Badge>
            <Badge variant="neutral">{entry.suggestedPermissionLevel}</Badge>
          </div>
          <p className="mrd-caption mrd-secondary" style={{ marginTop: 4 }}>{entry.description}</p>
        </div>
        <Button size="sm" disabled={entry.installs.length === 0} onClick={onInstall}>
          Install
        </Button>
      </div>
    </Card>
  );
}

function PlaygroundDialog({ server, tools, onClose }: { server: McpServerView; tools: McpToolView[]; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [tool, setTool] = useState(tools[0]?.name ?? '');
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async () => {
    setBusy(true);
    setResult(null);
    try {
      const args = JSON.parse(argsText || '{}') as Record<string, unknown>;
      const res = await api.callMcpTool(server.id, { tool, args });
      setResult(JSON.stringify(res, null, 2));
    } catch (e) {
      toast({ level: 'error', message: 'Tool call failed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={`${server.name} playground`} description="Call a tool and see the raw response.">
      <Stack gap={4}>
        <Field label="Tool">
          <select className="mrd-select" value={tool} onChange={(e) => setTool(e.target.value)}>
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {tools.find((t) => t.name === tool)?.description && (
          <p className="mrd-caption mrd-secondary">{tools.find((t) => t.name === tool)?.description}</p>
        )}
        <Field label="Arguments (JSON)">
          <textarea className="mrd-textarea mrd-code" rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        </Field>
        <Button disabled={busy || !tool} onClick={() => void call()}>
          Call tool
        </Button>
        {result && <pre className="mrd-pre mrd-code" style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{result}</pre>}
      </Stack>
    </Dialog>
  );
}
