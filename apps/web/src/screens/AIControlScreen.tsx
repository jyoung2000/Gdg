import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  IconCpu,
  IconRefresh,
  IconSearch,
  SearchField,
  Stack,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@meridian/ui';
import { formatRelative } from '@meridian/shared';
import {
  api,
  type CapabilityMatchView,
  type ConnectionView,
  type ModelCapabilitiesView,
  type ModelChangeView,
  type ModelView,
} from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * The AI Control Center: every model Meridian knows about, what each can do
 * and how confident that claim is, what changed recently, and which providers
 * are actually connected.
 *
 * The organising rule of this screen is that a capability badge is never a
 * bare assertion — it carries the evidence behind it, so a name-derived guess
 * reads differently from something the provider declared or a probe proved.
 */
export function AIControlScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const models = useStore((s) => s.models);
  const refreshModels = useStore((s) => s.refreshModels);
  const [tab, setTab] = useState('library');
  const [query, setQuery] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<ModelCapabilitiesView | null>(null);
  const [changes, setChanges] = useState<ModelChangeView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{ requirement: Record<string, unknown>; matches: CapabilityMatchView[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshModels();
    void api.modelChanges(50).then((r) => setChanges(r.changes)).catch(() => undefined);
    void api.connections().then((r) => setConnections(r.connections)).catch(() => undefined);
  }, [refreshModels]);

  const discover = async (force: boolean) => {
    setBusy(true);
    try {
      const result = await api.discoverModels(force);
      await refreshModels();
      const [c, ch] = await Promise.all([api.connections(), api.modelChanges(50)]);
      setConnections(c.connections);
      setChanges(ch.changes);
      toast({
        level: 'success',
        message: `Discovery finished: ${result.models} model(s) from ${result.providers} provider(s)`,
        // Skipped providers are reported, not hidden: a paced or backed-off
        // provider looks identical to a broken one otherwise.
        detail: result.skipped.length ? `Skipped ${result.skipped.length}: ${result.skipped[0]}` : undefined,
      });
    } catch (e) {
      toast({ level: 'error', message: 'Discovery failed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (modelId: string) => {
    try {
      setInspecting(await api.modelCapabilities(modelId));
    } catch (e) {
      toast({ level: 'error', message: 'Could not read capabilities', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setBusy(true);
    try {
      setSearchResult(await api.capabilitySearch({ query: searchQuery, limit: 25 }));
    } catch (e) {
      toast({ level: 'error', message: 'Search failed', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (q && !`${m.id} ${m.displayName} ${m.providerId}`.toLowerCase().includes(q)) return false;
      if (capabilityFilter && !m.capabilities.includes(capabilityFilter as never)) return false;
      return true;
    });
  }, [models, query, capabilityFilter]);

  // Recently discovered: driven by real change records, not by a guess made
  // at render time from an updatedAt field.
  const recent = changes.filter((c) => c.kind === 'discovered').slice(0, 20);
  const updated = changes.filter((c) => c.kind === 'updated').slice(0, 20);

  const capabilityVocabulary = ['vision', 'tools', 'reasoning', 'structured-output', 'long-context', 'embedding', 'image-generation'];

  return (
    <Screen
      title="AI"
      subtitle="Every model Meridian can reach, what it can do, and how we know"
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<IconRefresh />} disabled={busy} onClick={() => void discover(false)}>
            Discover
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void discover(true)}>
            Force refresh
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab value="library">Models ({models.length})</Tab>
          <Tab value="search">Capability search</Tab>
          <Tab value="changes">Changes ({changes.length})</Tab>
          <Tab value="connections">Connections</Tab>
        </TabList>

        <TabPanel value="library">
          <Stack gap={4}>
            <div className="mrd-hstack" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <SearchField value={query} onValueChange={setQuery} placeholder="Search models…" style={{ flex: 1, minWidth: 220 }} />
              {capabilityVocabulary.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={capabilityFilter === c ? 'primary' : 'secondary'}
                  onClick={() => setCapabilityFilter(capabilityFilter === c ? null : c)}
                >
                  {c}
                </Button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                icon={<IconCpu />}
                title={models.length ? 'No models match' : 'No models yet'}
                description={models.length ? 'Try a different search or capability filter.' : 'Connect a provider or start a local server, then run Discover.'}
              />
            ) : (
              <Stack gap={3}>
                {filtered.slice(0, 200).map((m) => (
                  <ModelRow key={m.id} model={m} onInspect={() => void inspect(m.id)} />
                ))}
              </Stack>
            )}
          </Stack>
        </TabPanel>

        <TabPanel value="search">
          <Stack gap={4}>
            <Card>
              <Stack gap={3}>
                <h2 className="mrd-heading">Find an AI by what it can do</h2>
                <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                  <SearchField
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    placeholder="e.g. analyze an image and browse the web"
                    style={{ flex: 1 }}
                  />
                  <Button icon={<IconSearch />} disabled={busy || !searchQuery.trim()} onClick={() => void runSearch()}>
                    Search
                  </Button>
                </div>
                {searchResult && (
                  <p className="mrd-caption mrd-secondary">
                    Read as: {(searchResult.requirement.capabilities as string[]).join(', ')}
                    {searchResult.requirement.localOnly ? ' · local only' : ''}
                    {searchResult.requirement.minContextLength ? ` · at least ${String(searchResult.requirement.minContextLength)} tokens` : ''}
                  </p>
                )}
              </Stack>
            </Card>

            {searchResult && (
              <Stack gap={3}>
                {searchResult.matches.map((m) => (
                  <Card key={m.modelId}>
                    <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                          <StatusChip status={m.eligible ? 'ready' : 'offline'} size="sm" label={m.eligible ? 'match' : 'no'} />
                          <strong className="mrd-truncate">{m.displayName}</strong>
                          <span className="mrd-caption mrd-secondary">{m.providerId}</span>
                        </div>
                        <div className="mrd-hstack" style={{ gap: 'var(--space-2)', marginTop: 4, flexWrap: 'wrap' }}>
                          {m.evidence.map((e) => (
                            <EvidenceBadge key={e.capability} capability={e.capability} state={e.state} />
                          ))}
                        </div>
                        <p className="mrd-caption mrd-secondary" style={{ marginTop: 4 }}>
                          {m.reasons.join('; ')}
                        </p>
                      </div>
                      <span className="mrd-numeric mrd-caption">{Math.round(m.score * 100)}</span>
                    </div>
                  </Card>
                ))}
              </Stack>
            )}
          </Stack>
        </TabPanel>

        <TabPanel value="changes">
          <Stack gap={4}>
            <Card>
              <Stack gap={2}>
                <h2 className="mrd-heading">Recently discovered</h2>
                {recent.length === 0 ? (
                  <p className="mrd-secondary">Nothing new since the last discovery pass.</p>
                ) : (
                  recent.map((c) => (
                    <div key={c.id} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                      <Badge variant="success">new</Badge>
                      <span className="mrd-code mrd-truncate">{c.modelId}</span>
                      <span className="mrd-caption mrd-secondary" style={{ marginLeft: 'auto' }}>{formatRelative(c.at, Date.now())}</span>
                    </div>
                  ))
                )}
              </Stack>
            </Card>
            <Card>
              <Stack gap={2}>
                <h2 className="mrd-heading">Updated</h2>
                {updated.length === 0 ? (
                  <p className="mrd-secondary">No model metadata has changed.</p>
                ) : (
                  updated.map((c) => (
                    <div key={c.id}>
                      <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <Badge>changed</Badge>
                        <span className="mrd-code mrd-truncate">{c.modelId}</span>
                        <span className="mrd-caption mrd-secondary" style={{ marginLeft: 'auto' }}>{formatRelative(c.at, Date.now())}</span>
                      </div>
                      {c.changes.map((ch, i) => (
                        <p key={i} className="mrd-caption mrd-secondary" style={{ marginLeft: 'var(--space-4)' }}>
                          {ch.field}: {ch.from ?? '—'} → {ch.to ?? '—'}
                        </p>
                      ))}
                    </div>
                  ))
                )}
              </Stack>
            </Card>
          </Stack>
        </TabPanel>

        <TabPanel value="connections">
          <Stack gap={3}>
            {connections.map((c) => (
              <Card key={c.providerId}>
                <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                      <StatusChip status={c.connected ? 'ready' : 'offline'} size="sm" label={c.connected ? 'connected' : 'not connected'} />
                      <strong>{c.name}</strong>
                      <Badge>{c.method}</Badge>
                      {c.models > 0 && <span className="mrd-caption mrd-secondary">{c.models} model(s)</span>}
                    </div>
                    {/* What the connection actually buys, in words: an API key is
                        billed usage and is never labelled a subscription. */}
                    <p className="mrd-caption mrd-secondary" style={{ marginTop: 4 }}>{c.grants}</p>
                    {c.detail && <p className="mrd-caption" style={{ marginTop: 2 }}>{c.detail}</p>}
                  </div>
                  {c.lastVerifiedAt && (
                    <span className="mrd-caption mrd-secondary">verified {formatRelative(c.lastVerifiedAt, Date.now())}</span>
                  )}
                </div>
              </Card>
            ))}
          </Stack>
        </TabPanel>
      </Tabs>

      {inspecting && <CapabilityInspector data={inspecting} onClose={() => setInspecting(null)} onChanged={() => void inspect(inspecting.modelId)} />}
    </Screen>
  );
}

function ModelRow({ model, onInspect }: { model: ModelView; onInspect: () => void }): React.JSX.Element {
  return (
    <Card>
      <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
            <strong className="mrd-truncate">{model.displayName}</strong>
            <span className="mrd-caption mrd-secondary">{model.providerId}</span>
            {model.free && <Badge variant="success">free</Badge>}
            {model.tags.includes('local') && <Badge>local</Badge>}
          </div>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)', marginTop: 4, flexWrap: 'wrap' }}>
            {model.capabilities.slice(0, 8).map((c) => (
              <Badge key={c} variant="neutral">{c}</Badge>
            ))}
            {model.contextLength && <span className="mrd-caption mrd-secondary">{Math.round(model.contextLength / 1000)}K ctx</span>}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={onInspect}>
          Inspect
        </Button>
      </div>
    </Card>
  );
}

/** A capability badge that shows its evidence, not just the claim. */
function EvidenceBadge({ capability, state }: { capability: string; state: string }): React.JSX.Element {
  const variant = state === 'probe_verified' || state === 'user_confirmed' ? 'success' : state === 'provider_declared' ? 'accent' : state === 'inferred' ? 'warning' : 'neutral';
  return (
    <Badge variant={variant as never} title={state}>
      {capability}
      {state === 'inferred' ? ' ?' : ''}
    </Badge>
  );
}

function CapabilityInspector({
  data,
  onClose,
  onChanged,
}: {
  data: ModelCapabilitiesView;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const label: Record<string, string> = {
    probe_verified: 'Verified by a live call',
    user_confirmed: 'Confirmed by an operator',
    provider_declared: 'Declared by the provider',
    inferred: 'Inferred from the model name',
    unsupported: 'Not supported',
    unknown: 'Unknown',
  };

  const [probing, setProbing] = useState(false);

  /**
   * Ask the model, rather than asking the catalogue.
   *
   * Until recently `probe_verified` was a state nothing could produce — this
   * dialog rendered "Verified by a live call" for a label no model could ever
   * earn. This button is the live call.
   */
  const probe = async () => {
    setProbing(true);
    try {
      const res = await api.verifyModel(data.modelId);
      const verdicts = res.models[0]?.results ?? [];
      const verified = verdicts.filter((r) => r.outcome === 'supported').length;
      const undecided = verdicts.filter((r) => r.outcome === 'inconclusive').length;
      toast({
        level: verified > 0 ? 'success' : 'info',
        message: `${verified} capabilit${verified === 1 ? 'y' : 'ies'} verified by a live call`,
        // An inconclusive probe changed nothing, and saying so is the
        // difference between "we checked and it cannot" and "we could not tell".
        detail: undecided ? `${undecided} probe(s) reached no verdict and recorded nothing` : undefined,
      });
      onChanged();
    } catch (e) {
      toast({ level: 'error', message: 'Could not probe this model', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setProbing(false);
    }
  };

  const confirm = async (capability: string, supported: boolean) => {
    try {
      await api.confirmCapability(data.modelId, capability, supported);
      toast({ level: 'success', message: `${capability} marked ${supported ? 'supported' : 'unsupported'}` });
      onChanged();
    } catch (e) {
      toast({ level: 'error', message: 'Could not record that', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={data.displayName} description={data.modelId} size="lg">
      <Stack gap={4}>
        <div className="mrd-hstack" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <StatusChip status={data.availability.available ? 'ready' : 'offline'} size="sm" label={data.availability.available ? 'available' : 'unavailable'} />
          {data.availability.local && <Badge>local</Badge>}
          <span className="mrd-caption mrd-secondary">{data.contextLength ? `${data.contextLength.toLocaleString()} token context` : 'context length unknown'}</span>
          <span className="mrd-caption mrd-secondary">{data.pricing.kind}</span>
        </div>
        {data.availability.detail && <p className="mrd-caption">{data.availability.detail}</p>}

        <div>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
            <h3 className="mrd-heading">Capabilities</h3>
            <div className="mrd-spacer" />
            <Button size="sm" variant="secondary" onClick={() => void probe()} disabled={probing}>
              {probing ? 'Probing…' : 'Verify with a live call'}
            </Button>
          </div>
          <p className="mrd-caption mrd-secondary">
            Unknown means nobody has told us — it is not the same as unsupported. Confirm one to record it deliberately,
            or probe the model to find out. A probe sends a real, tiny request and costs whatever this model charges.
          </p>
          <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
            {data.capabilities.map((c) => (
              <div key={c.capability} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                <span style={{ width: 150 }} className="mrd-truncate">{c.capability}</span>
                <StatusChip
                  status={c.state === 'probe_verified' || c.state === 'user_confirmed' ? 'ready' : c.state === 'provider_declared' ? 'ready' : c.state === 'unsupported' ? 'offline' : 'unknown'}
                  size="sm"
                  label={label[c.state] ?? c.state}
                />
                <span className="mrd-caption mrd-secondary mrd-truncate" style={{ flex: 1 }}>{c.source}</span>
                <Button size="sm" variant="tertiary" onClick={() => void confirm(c.capability, true)}>
                  Yes
                </Button>
                <Button size="sm" variant="tertiary" onClick={() => void confirm(c.capability, false)}>
                  No
                </Button>
              </div>
            ))}
          </Stack>
        </div>
      </Stack>
    </Dialog>
  );
}
