import { useEffect, useState } from 'react';
import {
  Button,
  DataUseTable,
  Dialog,
  Field,
  Input,
  ProviderCard,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
  StatusChip,
  TrustLabel,
  IconServer,
  EmptyState,
} from '@meridian/ui';
import type { CredentialRecord } from '@meridian/shared';
import { api, type ProviderView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

type Filter = 'all' | 'configured' | 'available';

/**
 * Provider administration.
 *
 * The support state is the honest answer to "can I actually use this": an
 * adapter exists, a credential is present, and the capabilities were confirmed
 * by a live call. Anything short of that is labelled as such rather than shown
 * as ready.
 */
export function ProvidersScreen(): React.JSX.Element {
  const providers = useStore((s) => s.providers);
  const refreshProviders = useStore((s) => s.refreshProviders);
  const toast = useStore((s) => s.toast);

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState<ProviderView | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const visible = providers.filter((p) => {
    if (query && !`${p.name} ${p.id} ${p.kinds.join(' ')}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === 'configured') return p.supportState === 'supported' || p.supportState === 'experimental';
    if (filter === 'available') return p.supportState === 'not_configured';
    return true;
  });

  const verify = async (id: string): Promise<void> => {
    setVerifying(id);
    try {
      const res = await api.verifyProvider(id);
      await refreshProviders();
      toast({
        level: res.ok ? 'success' : 'warn',
        message: res.ok ? `${id} verified` : `${id} could not be verified`,
        detail: res.detail,
      });
    } finally {
      setVerifying(null);
    }
  };

  return (
    <Screen
      title="Providers"
      subtitle="Meridian only routes to a provider once an adapter, a credential and a live check all line up."
      actions={
        <Button
          variant="secondary"
          onClick={async () => {
            const res = await api.discover();
            await refreshProviders();
            await useStore.getState().refreshModels();
            toast({ level: 'success', message: `Discovery finished`, detail: `${res.models} models across ${res.providers} providers` });
          }}
        >
          Discover
        </Button>
      }
    >
      <Stack direction="row" gap={3} align="center" wrap>
        <SearchField
          value={query}
          onValueChange={setQuery}
          onClear={() => setQuery('')}
          placeholder="Search providers"
          aria-label="Search providers"
          style={{ minWidth: 220, flex: '1 1 220px' }}
        />
        <SegmentedControl
          size="sm"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'configured', label: 'Configured' },
            { value: 'available', label: 'Available' },
          ]}
        />
      </Stack>

      {visible.length === 0 ? (
        <EmptyState icon={<IconServer />} title="No providers match" description="Try a different search or filter." />
      ) : (
        <div className="app__grid">
          {visible.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              health={p.health}
              supportState={p.supportState}
              models={p.models}
              freeModels={p.freeModels}
              paidModels={p.paidModels}
              cooldownSec={p.cooldownSec}
              onManage={() => setManaging(p)}
              onVerify={() => void verify(p.id)}
              verifying={verifying === p.id}
            />
          ))}
        </div>
      )}

      {managing && <ManageDialog provider={managing} onClose={() => setManaging(null)} onChanged={() => void refreshProviders()} />}
    </Screen>
  );
}

function ManageDialog({
  provider,
  onClose,
  onChanged,
}: {
  provider: ProviderView;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState(`${provider.name} key`);
  const [trust, setTrust] = useState(provider.trust);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .credentials()
      .then((r) => setCredentials(r.credentials.filter((c) => c.providerId === provider.id)))
      .catch(() => undefined);
  }, [provider.id]);

  const addCredential = async (): Promise<void> => {
    if (!secret.trim()) return;
    setBusy(true);
    try {
      await api.addCredential({ providerId: provider.id, secret: secret.trim(), label });
      // The secret is cleared immediately; it is never held in component state
      // longer than the request that carries it.
      setSecret('');
      const r = await api.credentials();
      setCredentials(r.credentials.filter((c) => c.providerId === provider.id));
      onChanged();
      toast({ level: 'success', message: 'Credential added' });
    } catch (e) {
      toast({ level: 'error', message: 'Could not add the credential', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={provider.name} size="lg">
      <Stack direction="column" gap={5}>
        <Stack direction="row" gap={2} align="center" wrap>
          <StatusChip
            status={provider.supportState === 'supported' ? 'ready' : provider.supportState === 'experimental' ? 'degraded' : 'unknown'}
            label={supportLabel(provider.supportState)}
            size="sm"
          />
          <TrustLabel trust={provider.trust} />
          {provider.local && <StatusChip status="ready" label="Local" size="sm" />}
          <div className="mrd-spacer" />
          {provider.docsUrl && (
            <a className="mrd-caption" href={provider.docsUrl} target="_blank" rel="noreferrer noopener">
              Provider documentation
            </a>
          )}
        </Stack>

        {provider.notes && <p className="mrd-secondary">{provider.notes}</p>}

        <section>
          <h3 className="mrd-panel-title">Credentials</h3>
          {credentials.length > 0 && (
            <Stack direction="column" gap={2}>
              {credentials.map((c) => (
                <Stack key={c.id} direction="row" gap={2} align="center">
                  <span className="mrd-body mrd-truncate">{c.label}</span>
                  <span className="mrd-code mrd-caption">{c.hint}</span>
                  <StatusChip status={c.enabled ? 'ready' : 'offline'} label={c.scope} size="sm" />
                  <div className="mrd-spacer" />
                  <Button
                    size="sm"
                    variant="tertiary"
                    onClick={async () => {
                      await api.deleteCredential(c.id);
                      setCredentials((s) => s.filter((x) => x.id !== c.id));
                      onChanged();
                    }}
                  >
                    Remove
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
          {provider.auth === 'none' ? (
            <p className="mrd-secondary">This provider needs no credential.</p>
          ) : (
            <Stack direction="column" gap={3} style={{ marginTop: 'var(--space-3)' }}>
              <Field label="Label">
                <Input value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
              </Field>
              <Field
                label="API key"
                description={`Stored encrypted. It is never returned by the API, never written to a log, and never shown again after you save it.${
                  provider.envKeys.length ? ` You can also set ${provider.envKeys[0]} in the environment.` : ''
                }`}
              >
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.currentTarget.value)}
                  placeholder="Paste the key"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Stack direction="row" gap={2} justify="end">
                <Button variant="primary" loading={busy} disabled={!secret.trim()} onClick={() => void addCredential()}>
                  Save credential
                </Button>
              </Stack>
            </Stack>
          )}
        </section>

        <section>
          <h3 className="mrd-panel-title">Data use</h3>
          <p className="mrd-caption">
            Meridian ships "unknown" rather than guessing what a provider does with your requests. Read their policy, then
            record what you verified.
          </p>
          <DataUseTable policy={provider.dataUse} />
        </section>

        <section>
          <h3 className="mrd-panel-title">Routing</h3>
          <Stack direction="column" gap={3}>
            <Field label="Trust" description="Private and sensitive work is only routed to verified or trusted providers.">
              <Select value={trust} onChange={(e) => setTrust(e.currentTarget.value as typeof trust)}>
                <option value="verified">Verified — you have checked this yourself</option>
                <option value="trusted">Trusted</option>
                <option value="unknown">Unknown</option>
                <option value="untrusted">Untrusted</option>
              </Select>
            </Field>
            <Field label="Base URL" description="Override for a proxy or a self-hosted deployment.">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} spellCheck={false} />
            </Field>
          </Stack>
        </section>

        <Stack direction="row" gap={2} justify="end">
          <Button variant="tertiary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await api.updateProvider(provider.id, { trust, baseUrl });
              onChanged();
              toast({ level: 'success', message: `${provider.name} updated` });
              onClose();
            }}
          >
            Save changes
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

function supportLabel(state: string): string {
  switch (state) {
    case 'supported':
      return 'Supported';
    case 'experimental':
      return 'Not verified';
    case 'not_configured':
      return 'Not configured';
    default:
      return 'Unavailable';
  }
}
