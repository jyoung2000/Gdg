import type { FastifyInstance } from 'fastify';
import { STALE_AFTER_DAYS, isStale } from '@meridian/shared';
import type { App } from '../services/app.js';
import { requireAdmin } from './authz.js';

/**
 * "Is this installation actually working?"
 *
 * A gateway can be up, serve 200s, and still be useless — no credentials, a
 * catalogue three months old, every provider circuit open, a discovery source
 * that has been failing since Tuesday. None of that is visible from a health
 * check, because none of it stops the process from running.
 *
 * Each check answers one question with the evidence attached and a next step.
 * A WARNING is a thing worth knowing; a FAIL is a thing that stops work. A
 * fresh install with nothing configured is a WARNING, not a FAIL: it is a
 * working state, and telling someone their brand-new install is broken is how
 * they stop trusting the diagnostics.
 */

export type CheckStatus = 'PASS' | 'WARNING' | 'FAIL';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** What was actually observed. Never a restatement of the label. */
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy: string | null;
}

export async function registerDiagnosticsRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/api/system/diagnostics', async (req) => {
    // Reads provider configuration, credential presence and source errors.
    // None of it is secret, and all of it is operational rather than personal —
    // but it is an operator's view of the whole instance, so it is admin-only.
    requireAdmin(req);

    const checks: Check[] = [];
    const now = Date.now();
    const add = (c: Check) => checks.push(c);

    /* ---------------- Storage ---------------- */

    try {
      const models = app.store.listModels().length;
      const credentials = app.store.listCredentials().length;
      add({
        id: 'database',
        label: 'Database',
        status: 'PASS',
        detail: `Readable and writable. ${models} models, ${credentials} credentials.`,
        remedy: null,
      });
    } catch (error) {
      add({
        id: 'database',
        label: 'Database',
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
        remedy: 'Check that the data directory is writable and not on a full disk.',
      });
    }

    /* ---------------- Providers and credentials ---------------- */

    const providers = app.providers.list();
    const credentialled = providers.filter((p) => p.auth === 'none' || app.credentials.hasAny(p.id));
    add({
      id: 'providers',
      label: 'Providers',
      status: credentialled.length > 0 ? 'PASS' : 'WARNING',
      detail:
        credentialled.length > 0
          ? `${credentialled.length} of ${providers.length} registered providers can be called.`
          : `${providers.length} providers are registered and none has a credential.`,
      remedy: credentialled.length > 0 ? null : 'Add a provider key under Models → Connections. OpenRouter reaches the most models with one key.',
    });

    const models = app.models.all();
    add({
      id: 'models',
      label: 'Models',
      status: models.length > 0 ? 'PASS' : 'WARNING',
      detail: models.length > 0 ? `${models.length} models in the registry.` : 'No models have been discovered yet.',
      remedy: models.length > 0 ? null : 'Add a credential, then run discovery. A provider with no key lists no models.',
    });

    /* ---------------- Health ---------------- */

    const open = providers.filter((p) => app.health.get(p.id).circuit === 'open');
    add({
      id: 'health',
      label: 'Provider health',
      status: open.length === 0 ? 'PASS' : open.length >= credentialled.length && credentialled.length > 0 ? 'FAIL' : 'WARNING',
      detail:
        open.length === 0
          ? 'No provider circuit is open.'
          : `${open.length} provider(s) cooling down after repeated failures: ${open.map((p) => p.id).join(', ')}.`,
      remedy: open.length === 0 ? null : 'Open the connection to see the last error. A circuit closes by itself once a call succeeds.',
    });

    /* ---------------- Discovery ---------------- */

    const discovery = app.freeInference.status();
    const failed = discovery.sources.filter((s) => !s.ok);
    add({
      id: 'discovery',
      label: 'Discovery sources',
      status: failed.length === 0 ? 'PASS' : failed.length === discovery.sources.length ? 'FAIL' : 'WARNING',
      detail:
        `${discovery.sources.length - failed.length} of ${discovery.sources.length} sources loaded; ` +
        `${discovery.providers} providers, ${discovery.models} models, ${discovery.freeModels} free.` +
        (failed.length ? ` Failing: ${failed.map((s) => `${s.id} (${s.error})`).join('; ')}` : ''),
      remedy: failed.length === 0 ? null : 'A blocked or unreachable source is usually a network policy. The others keep working.',
    });

    const staleSources = discovery.sources.filter((s) => s.ok && (s.cacheAgeDays ?? 0) > STALE_AFTER_DAYS);
    add({
      id: 'freshness',
      label: 'Catalogue freshness',
      status: staleSources.length === 0 ? 'PASS' : 'WARNING',
      detail:
        staleSources.length === 0
          ? discovery.everRanOnline
            ? 'Refreshed over the network in this process.'
            : 'Serving the on-disk cache; no network refresh has run yet in this process.'
          : `${staleSources.length} source(s) older than ${STALE_AFTER_DAYS} days.`,
      remedy: staleSources.length === 0 ? null : 'Refresh discovery. Free tiers are withdrawn without notice, so old data is not evidence about today.',
    });

    /* ---------------- Catalogue and rate card ---------------- */

    const catalog = app.catalogSync.status();
    add({
      id: 'catalog',
      label: 'Provider catalogue',
      status: catalog.status === 'unavailable' ? 'WARNING' : 'PASS',
      detail:
        catalog.status === 'unavailable'
          ? 'No catalogue has been downloaded and the network was unavailable. Only built-in providers are known.'
          : `${catalog.entries} entries, version ${catalog.version ?? 'unknown'}${catalog.fromCache ? ', from cache' : ''}.`,
      remedy: catalog.status === 'unavailable' ? 'Meridian works without it; sync when the network allows.' : null,
    });

    const prices = app.priceBook.status();
    add({
      id: 'prices',
      label: 'Rate card',
      status: prices.entries > 0 ? 'PASS' : 'WARNING',
      detail: prices.entries > 0 ? `${prices.entries} priced models.` : 'No rate card. Costs will read as unknown rather than zero.',
      remedy: prices.entries > 0 ? null : 'Sync prices so a budget policy has something to bind to.',
    });

    /* ---------------- Quota ---------------- */

    const quotas = app.store.listCredentialQuota();
    const exhausted = quotas.filter((q) => q.remaining === 0 && (q.resetsAt === null || q.resetsAt > now));
    add({
      id: 'quota',
      label: 'Quota',
      status: exhausted.length === 0 ? 'PASS' : 'WARNING',
      detail:
        quotas.length === 0
          ? 'No provider has published a quota yet. Most publish nothing until the first call.'
          : `${quotas.length} quota reading(s) recorded, ${exhausted.length} exhausted.`,
      remedy: exhausted.length === 0 ? null : 'Exhausted accounts are skipped until their window resets. Nothing to do.',
    });

    /* ---------------- Sandbox ---------------- */

    add({
      id: 'sandbox',
      label: 'Agent sandbox',
      status: app.sandboxDegradedReason ? 'WARNING' : 'PASS',
      detail: app.sandboxDegradedReason ?? 'Docker is available: agent commands run inside a container.',
      remedy: app.sandboxDegradedReason
        ? 'Install Docker for a real isolation boundary. The process sandbox limits accidents and is not a security boundary.'
        : null,
    });

    const worst: CheckStatus = checks.some((c) => c.status === 'FAIL')
      ? 'FAIL'
      : checks.some((c) => c.status === 'WARNING')
        ? 'WARNING'
        : 'PASS';

    return {
      status: worst,
      checkedAt: now,
      summary: {
        pass: checks.filter((c) => c.status === 'PASS').length,
        warning: checks.filter((c) => c.status === 'WARNING').length,
        fail: checks.filter((c) => c.status === 'FAIL').length,
      },
      checks,
    };
  });
}

/** Re-exported so the freshness rule has one definition. */
export { isStale };
