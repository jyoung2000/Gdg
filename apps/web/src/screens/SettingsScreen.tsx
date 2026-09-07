import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DisclosureRow,
  Fieldset,
  FormRow,
  Input,
  KeyValue,
  SegmentedControl,
  Select,
  Stack,
  StatusChip,
  Switch,
  Table,
  IconCopy,
  IconKey,
  type TableColumn,
} from '@meridian/ui';
import { formatRelative } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

type Section =
  | 'general'
  | 'appearance'
  | 'ai'
  | 'routing'
  | 'agents'
  | 'workspace'
  | 'security'
  | 'privacy'
  | 'keys'
  | 'advanced';

const SECTIONS: { id: Section; label: string; description: string }[] = [
  { id: 'general', label: 'General', description: 'Instance identity and defaults' },
  { id: 'appearance', label: 'Appearance', description: 'Theme, motion, density' },
  { id: 'ai', label: 'AI', description: 'Preferred models and providers' },
  { id: 'routing', label: 'Routing', description: 'How Meridian chooses a model' },
  { id: 'agents', label: 'Agents', description: 'The specialist roster' },
  { id: 'workspace', label: 'Workspace', description: 'Defaults for new workspaces' },
  { id: 'security', label: 'Security', description: 'Sandboxing and execution' },
  { id: 'privacy', label: 'Privacy', description: 'Where your code may be sent' },
  { id: 'keys', label: 'API keys', description: 'Gateway access for other tools' },
  { id: 'advanced', label: 'Advanced', description: 'Diagnostics and reset' },
];

/**
 * Settings, laid out as a desktop settings application: a list of categories on
 * the left, one detail pane on the right, rows of labelled controls rather than
 * a wall of dashboard cards.
 */
export function SettingsScreen(): React.JSX.Element {
  const [section, setSection] = useState<Section>('general');
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="settings">
      <nav className="settings__nav mrd-scroll" aria-label="Settings categories">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings__navitem${section === s.id ? ' settings__navitem--active' : ''} mrd-focus-ring`}
            aria-current={section === s.id ? 'page' : undefined}
            onClick={() => setSection(s.id)}
          >
            <span className="settings__navlabel">{s.label}</span>
            <span className="mrd-caption settings__navdesc">{s.description}</span>
          </button>
        ))}
      </nav>

      <div className="settings__detail mrd-scroll">
        <header className="settings__header">
          <h1 className="mrd-title">{current.label}</h1>
          <p className="mrd-secondary">{current.description}</p>
        </header>
        <div className="settings__body">
          {section === 'general' && <GeneralSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'ai' && <AiSection />}
          {section === 'routing' && <RoutingSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'workspace' && <WorkspaceSection />}
          {section === 'security' && <SecuritySection />}
          {section === 'privacy' && <PrivacySection />}
          {section === 'keys' && <KeysSection />}
          {section === 'advanced' && <AdvancedSection />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GeneralSection(): React.JSX.Element {
  const info = useStore((s) => s.info);
  if (!info) return <div className="mrd-secondary">Loading…</div>;

  return (
    <Stack direction="column" gap={5}>
      <Fieldset title="This instance">
        <FormRow label="Version" description="Meridian build currently running.">
          <span className="mrd-secondary">{info.version}</span>
        </FormRow>
        <FormRow label="Port" description="The single port that serves the app, both APIs and the event stream.">
          <span className="mrd-secondary mrd-numeric">{info.port}</span>
        </FormRow>
        <FormRow label="OpenAI-compatible endpoint" description="Point any OpenAI SDK or tool here.">
          <CopyValue value={`${location.origin}${info.endpoints.openai}`} />
        </FormRow>
        <FormRow label="Anthropic-compatible endpoint" description="Point Claude Code or any Messages-API client here.">
          <CopyValue value={`${location.origin}${info.endpoints.anthropic}`} />
        </FormRow>
      </Fieldset>

      <Fieldset title="Inventory">
        <KeyValue
          items={[
            { label: 'Providers in catalog', value: String(info.counts.providers) },
            { label: 'Providers configured', value: String(info.counts.providersConfigured) },
            { label: 'Providers verified', value: String(info.counts.providersVerified) },
            { label: 'Models routable', value: String(info.counts.models) },
            { label: 'Inference pools', value: String(info.counts.pools) },
            { label: 'Workspaces', value: String(info.counts.workspaces) },
          ]}
        />
      </Fieldset>

      {info.warnings.length > 0 && (
        <Fieldset title="Warnings" footnote="These are things worth fixing before this instance carries anything important.">
          <Stack direction="column" gap={2}>
            {info.warnings.map((w, i) => (
              <Stack key={i} direction="row" gap={2} align="start">
                <StatusChip status={w.level === 'warn' ? 'degraded' : 'unknown'} label={w.level} size="sm" />
                <span className="mrd-secondary">{w.message}</span>
              </Stack>
            ))}
          </Stack>
        </Fieldset>
      )}
    </Stack>
  );
}

function AppearanceSection(): React.JSX.Element {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const reduceMotion = useStore((s) => s.reduceMotion);
  const setReduceMotion = useStore((s) => s.setReduceMotion);
  const layout = useStore((s) => s.layout);
  const patchLayout = useStore((s) => s.patchLayout);

  return (
    <Stack direction="column" gap={5}>
      <Fieldset title="Theme">
        <FormRow label="Appearance" description="Dark mode is a separate palette, not an inversion of the light one.">
          <SegmentedControl
            size="sm"
            value={theme}
            onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </FormRow>
        <FormRow
          label="Reduce motion"
          description="Collapses every transition. Also applied automatically when your system asks for reduced motion."
        >
          <Switch checked={reduceMotion} onCheckedChange={setReduceMotion} aria-label="Reduce motion" />
        </FormRow>
      </Fieldset>

      <Fieldset title="Layout" footnote="Panel sizes and collapse state are remembered on this device.">
        <FormRow label="Sidebar" description="Collapse to icons to recover horizontal space.">
          <Switch
            checked={!layout.sidebarCollapsed}
            onCheckedChange={(v) => patchLayout({ sidebarCollapsed: !v })}
            aria-label="Expanded sidebar"
          />
        </FormRow>
        <FormRow label="Assistant panel" description="The agent control surface on the right.">
          <Switch checked={layout.inspectorOpen} onCheckedChange={(v) => patchLayout({ inspectorOpen: v })} aria-label="Assistant panel" />
        </FormRow>
      </Fieldset>
    </Stack>
  );
}

function AiSection(): React.JSX.Element {
  const prefs = useStore((s) => s.preferences);
  const models = useStore((s) => s.models);
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const [preferredModels, setPreferredModels] = useState<string[]>(prefs?.preferredModels ?? []);
  const [preferredProviders, setPreferredProviders] = useState<string[]>(prefs?.preferredProviders ?? []);

  const updatePreferences = useStore((s) => s.updatePreferences);
  const save = async (patch: Record<string, unknown>): Promise<void> => {
    if (!prefs) return;
    await updatePreferences(patch as Partial<typeof prefs>);
    toast({ level: 'success', message: 'Preferences saved' });
  };

  return (
    <Stack direction="column" gap={5}>
      <Fieldset
        title="Preferred models"
        footnote="Preferences raise a model's ranking; they never override a hard constraint such as a missing capability or an unhealthy provider."
      >
        {models.slice(0, 30).map((m) => (
          <FormRow key={m.id} label={m.displayName} description={`${m.providerId}${m.free ? ' · free' : ''}`}>
            <Switch
              checked={preferredModels.includes(m.id)}
              aria-label={`Prefer ${m.displayName}`}
              onCheckedChange={(v) => {
                const next = v ? [...preferredModels, m.id] : preferredModels.filter((x) => x !== m.id);
                setPreferredModels(next);
                void save({ preferredModels: next });
              }}
            />
          </FormRow>
        ))}
      </Fieldset>

      <Fieldset title="Preferred providers">
        {providers
          .filter((p) => p.supportState !== 'not_configured' && p.supportState !== 'unavailable')
          .map((p) => (
            <FormRow key={p.id} label={p.name} description={p.trust}>
              <Switch
                checked={preferredProviders.includes(p.id)}
                aria-label={`Prefer ${p.name}`}
                onCheckedChange={(v) => {
                  const next = v ? [...preferredProviders, p.id] : preferredProviders.filter((x) => x !== p.id);
                  setPreferredProviders(next);
                  void save({ preferredProviders: next });
                }}
              />
            </FormRow>
          ))}
      </Fieldset>
    </Stack>
  );
}

function RoutingSection(): React.JSX.Element {
  const prefs = useStore((s) => s.preferences);
  const vocabulary = useStore((s) => s.vocabulary);
  const info = useStore((s) => s.info);
  const pools = useStore((s) => s.pools);
  const toast = useStore((s) => s.toast);
  const [maxCost, setMaxCost] = useState(prefs?.maxCostPerTask == null ? '' : String(prefs.maxCostPerTask));

  const updatePreferences = useStore((s) => s.updatePreferences);
  const save = async (patch: Record<string, unknown>): Promise<void> => {
    if (!prefs) return;
    await updatePreferences(patch as Partial<typeof prefs>);
    toast({ level: 'success', message: 'Routing preferences saved' });
  };

  return (
    <Stack direction="column" gap={5}>
      <Fieldset title="Default mode">
        {(vocabulary?.routingModes ?? []).filter((m) => m.primary).map((m) => (
          <FormRow key={m.value} label={m.value} description={m.description}>
            <Switch
              checked={prefs?.routingMode === m.value}
              aria-label={`Use ${m.value} by default`}
              onCheckedChange={(v) => v && void save({ routingMode: m.value })}
            />
          </FormRow>
        ))}
        <DisclosureRow label="Explicit policies" description="The full set of routing policies, for when the plain modes are not specific enough.">
          <Stack direction="column" gap={2}>
            {(vocabulary?.routingModes ?? []).filter((m) => !m.primary).map((m) => (
              <FormRow key={m.value} label={m.value} description={m.description}>
                <Switch
                  checked={prefs?.routingMode === m.value}
                  aria-label={`Use ${m.value} by default`}
                  onCheckedChange={(v) => v && void save({ routingMode: m.value })}
                />
              </FormRow>
            ))}
          </Stack>
        </DisclosureRow>
      </Fieldset>

      <Fieldset
        title="Spending"
        footnote={
          info?.allowPaid
            ? 'Paid routing is enabled for this instance. A request still has to ask for it.'
            : 'Paid routing is disabled for this whole instance. Nothing can spend money until an operator sets MERIDIAN_ALLOW_PAID.'
        }
      >
        <FormRow label="Allow paid models" description="Without this, only models that cannot charge money are eligible.">
          <Switch
            checked={prefs?.allowPaid ?? false}
            disabled={!info?.allowPaid}
            aria-label="Allow paid models"
            onCheckedChange={(v) => void save({ allowPaid: v })}
          />
        </FormRow>
        <FormRow label="Cost ceiling per task, USD" description="A task estimated above this is refused before it starts. Empty means no ceiling.">
          <Input
            value={maxCost}
            inputMode="decimal"
            style={{ width: 120 }}
            onChange={(e) => setMaxCost(e.currentTarget.value)}
            onBlur={() => void save({ maxCostPerTask: maxCost === '' ? null : Number(maxCost) })}
            aria-label="Cost ceiling per task in dollars"
          />
        </FormRow>
      </Fieldset>

      <Fieldset title="Default pool">
        <FormRow label="Pool" description="Choosing a pool chooses its policy, which overrides the mode above.">
          <Select
            value={prefs?.preferredPool ?? ''}
            onChange={(e) => void save({ preferredPool: e.currentTarget.value || null })}
            aria-label="Default pool"
          >
            <option value="">Let Meridian choose</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.strategy}
              </option>
            ))}
          </Select>
        </FormRow>
      </Fieldset>
    </Stack>
  );
}

function AgentsSection(): React.JSX.Element {
  const vocabulary = useStore((s) => s.vocabulary);
  return (
    <Fieldset
      title="Roster"
      footnote="Each agent routes through the pool named here, so a cheap step never consumes a frontier model's budget."
    >
      {(vocabulary?.agents ?? []).map((a) => (
        <DisclosureRow key={a.role} label={a.name} description={a.description}>
          <KeyValue
            items={[
              { label: 'Task type', value: a.taskType },
              { label: 'Routing mode', value: a.preferredMode },
              { label: 'Pool', value: a.pool },
              { label: 'Max steps', value: String(a.maxSteps) },
              { label: 'Tools', value: a.tools.join(', ') },
            ]}
          />
        </DisclosureRow>
      ))}
    </Fieldset>
  );
}

function WorkspaceSection(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces);
  const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
  const toast = useStore((s) => s.toast);

  return (
    <Fieldset
      title="Workspaces"
      footnote="Removing a workspace here only removes Meridian's record of it. The directory and anything uncommitted in it are left alone."
    >
      {workspaces.map((w) => (
        <FormRow key={w.id} label={w.name} description={w.repoUrl ?? w.path}>
          <Stack direction="row" gap={2} align="center">
            <StatusChip status="unknown" label={w.privacyMode} size="sm" />
            <Button
              size="sm"
              variant="tertiary"
              onClick={async () => {
                const res = await api.deleteWorkspace(w.id);
                await refreshWorkspaces();
                toast({ level: 'info', message: 'Workspace removed', detail: res.note });
              }}
            >
              Remove
            </Button>
          </Stack>
        </FormRow>
      ))}
    </Fieldset>
  );
}

function SecuritySection(): React.JSX.Element {
  const info = useStore((s) => s.info);
  if (!info) return <div className="mrd-secondary">Loading…</div>;

  return (
    <Stack direction="column" gap={5}>
      <Fieldset title="Command execution" footnote={info.sandbox.isolation}>
        <FormRow label="Sandbox" description="How commands started by an agent or the terminal are isolated.">
          <StatusChip
            status={info.sandbox.kind === 'docker' ? 'ready' : info.sandbox.kind === 'disabled' ? 'offline' : 'degraded'}
            label={info.sandbox.kind}
            size="sm"
          />
        </FormRow>
        <FormRow label="Outbound network" description="Also gates the agents' web_fetch tool. Off means nothing a model starts can reach the network.">
          <StatusChip status={info.sandbox.networkEnabled ? 'degraded' : 'ready'} label={info.sandbox.networkEnabled ? 'enabled' : 'disabled'} size="sm" />
        </FormRow>
      </Fieldset>

      {info.sandbox.degradedReason && (
        <Fieldset title="Sandbox is degraded">
          <p className="mrd-secondary">{info.sandbox.degradedReason}</p>
        </Fieldset>
      )}

      <Fieldset title="Access" footnote="These are set through the environment and take effect on restart.">
        <FormRow label="API key required" description="When off, this instance is single-user and trusts anything that can reach it.">
          <StatusChip status={info.authRequired ? 'ready' : 'degraded'} label={info.authRequired ? 'required' : 'open'} size="sm" />
        </FormRow>
      </Fieldset>

      <Fieldset
        title="Credential handling"
        footnote="Meridian discovers credentials only from environment variables you set and keys you enter here. It never reads browser storage, other applications' configuration, cloud metadata services, or repositories."
      >
        <KeyValue
          items={[
            { label: 'At rest', value: 'AES-256-GCM, key derived with scrypt' },
            { label: 'In responses', value: 'Never — only a four-character hint' },
            { label: 'In logs', value: 'Redacted before any sink' },
            { label: 'In the sandbox', value: 'Absent — the environment is rebuilt from scratch' },
          ]}
        />
      </Fieldset>
    </Stack>
  );
}

function PrivacySection(): React.JSX.Element {
  const prefs = useStore((s) => s.preferences);
  const vocabulary = useStore((s) => s.vocabulary);
  const toast = useStore((s) => s.toast);

  return (
    <Fieldset
      title="Privacy mode"
      footnote="A workspace can override this. Sensitive work is never routed to a provider that is not verified or trusted, whatever mode is chosen."
    >
      {(vocabulary?.privacyModes ?? []).map((m) => (
        <FormRow key={m.value} label={m.value.replace(/_/g, ' ').toLowerCase()} description={m.description}>
          <Switch
            checked={prefs?.privacyMode === m.value}
            aria-label={`Use ${m.value}`}
            onCheckedChange={async (v) => {
              if (!v || !prefs) return;
              await useStore.getState().updatePreferences({ privacyMode: m.value as typeof prefs.privacyMode });
              toast({ level: 'success', message: 'Privacy mode saved' });
            }}
          />
        </FormRow>
      ))}
    </Fieldset>
  );
}

function KeysSection(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.apiKeys>>['keys']>([]);
  const [created, setCreated] = useState<{ key: string; note: string } | null>(null);
  const [name, setName] = useState('');

  const load = (): void => {
    void api.apiKeys().then((r) => setKeys(r.keys));
  };
  useEffect(load, []);

  const columns: TableColumn<(typeof keys)[number]>[] = [
    { key: 'name', header: 'Name', render: (k) => k.name },
    { key: 'hint', header: 'Key', width: '120px', render: (k) => <span className="mrd-code">{k.hint}</span> },
    { key: 'created', header: 'Created', width: '120px', render: (k) => formatRelative(k.createdAt, Date.now()) },
    { key: 'used', header: 'Last used', width: '120px', render: (k) => (k.lastUsedAt ? formatRelative(k.lastUsedAt, Date.now()) : '—') },
    {
      key: 'actions',
      header: '',
      width: '90px',
      align: 'end',
      render: (k) => (
        <Button
          size="sm"
          variant="tertiary"
          onClick={async () => {
            await api.deleteApiKey(k.id);
            load();
          }}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Stack direction="column" gap={5}>
      <Fieldset
        title="Gateway API keys"
        footnote="Only a hash is stored, so a key cannot be recovered from the database. Revoking is immediate."
      >
        <FormRow label="New key" description="Give it a name you will recognise when revoking it later.">
          <Stack direction="row" gap={2}>
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Claude Code" aria-label="Key name" />
            <Button
              variant="primary"
              icon={<IconKey />}
              disabled={!name.trim()}
              onClick={async () => {
                const res = await api.createApiKey(name.trim());
                setCreated({ key: res.key, note: res.note });
                setName('');
                load();
              }}
            >
              Create
            </Button>
          </Stack>
        </FormRow>
      </Fieldset>

      <Table columns={columns} rows={keys} rowKey={(k) => k.id} empty="No API keys. Anyone who can reach this gateway can use it." />

      {created && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setCreated(null);
          }}
          title="Copy your API key"
          description={created.note}
        >
          <Stack direction="column" gap={3}>
            <code className="settings__key">{created.key}</code>
            <Stack direction="row" gap={2} justify="end">
              <Button
                variant="secondary"
                icon={<IconCopy />}
                onClick={async () => {
                  await navigator.clipboard.writeText(created.key).catch(() => undefined);
                  toast({ level: 'success', message: 'Copied' });
                }}
              >
                Copy
              </Button>
              <Button variant="primary" onClick={() => setCreated(null)}>
                Done
              </Button>
            </Stack>
          </Stack>
        </Dialog>
      )}
    </Stack>
  );
}

function AdvancedSection(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const refreshProviders = useStore((s) => s.refreshProviders);

  return (
    <Stack direction="column" gap={5}>
      <Fieldset title="Discovery">
        <FormRow label="Rediscover everything" description="Re-reads every configured provider's model listing and probes local servers.">
          <Button
            variant="secondary"
            onClick={async () => {
              const res = await api.discover();
              await refreshProviders();
              await useStore.getState().refreshModels();
              toast({ level: 'success', message: `Found ${res.models} models across ${res.providers} providers` });
            }}
          >
            Run discovery
          </Button>
        </FormRow>
      </Fieldset>

      <Fieldset title="Provider health" footnote="Resetting clears a provider's circuit breaker and error history, putting it straight back into rotation.">
        {providers
          .filter((p) => p.health.circuit !== 'closed' || p.health.errorRate > 0)
          .map((p) => (
            <FormRow key={p.id} label={p.name} description={p.health.lastError ?? `${Math.round(p.health.errorRate * 100)}% error rate`}>
              <Stack direction="row" gap={2} align="center">
                <StatusChip status={p.health.circuit === 'open' ? 'offline' : 'degraded'} label={p.health.circuit} size="sm" />
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={async () => {
                    await api.resetProviderHealth(p.id);
                    await refreshProviders();
                    toast({ level: 'success', message: `${p.name} health reset` });
                  }}
                >
                  Reset
                </Button>
              </Stack>
            </FormRow>
          ))}
      </Fieldset>
    </Stack>
  );
}

function CopyValue({ value }: { value: string }): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  return (
    <Stack direction="row" gap={2} align="center">
      <code className="mrd-code mrd-truncate">{value}</code>
      <Button
        size="sm"
        variant="tertiary"
        icon={<IconCopy />}
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => undefined);
          toast({ level: 'success', message: 'Copied' });
        }}
      >
        Copy
      </Button>
    </Stack>
  );
}
