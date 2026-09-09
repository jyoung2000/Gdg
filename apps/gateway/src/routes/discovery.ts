import type { FastifyInstance } from 'fastify';
import { MeridianError, freeAccessLabel, type FreeAccessKind } from '@meridian/shared';
import { PROVIDER_CATALOG } from '@meridian/provider-sdk';
import type { MergedModel } from '@meridian/model-sdk';
import type { App } from '../services/app.js';
import { requireAdmin } from './authz.js';

/**
 * The free-inference discovery API.
 *
 * What this is for: answering "what can I use right now that costs nothing",
 * with the evidence attached, so the answer can be checked rather than
 * believed. Every response here carries where a claim came from, how confident
 * that source was, and how old it is — a free-model list without those three is
 * a list of things that were free at some point.
 *
 * Reads are open, because they are how the product explains itself and because
 * nothing here is a secret: it is public data about public offerings. The
 * refresh is administrative, because it makes outbound requests on the
 * instance's behalf.
 */
export async function registerDiscoveryRoutes(server: FastifyInstance, app: App): Promise<void> {
  const shippedIds = new Set(PROVIDER_CATALOG.map((p) => p.id));

  /* ---------------- Status ---------------- */

  /**
   * Which sources loaded, how old their data is, and what was refused.
   *
   * The refusals matter as much as the successes: they are the record of a
   * source trying to claim something it had no standing to claim, and a
   * refusal count that suddenly jumps means an upstream changed its schema.
   */
  server.get('/api/discovery/status', async () => {
    const status = app.freeInference.status();
    return {
      status,
      // Said plainly rather than implied by a null: a catalogue that has only
      // ever been read from disk is a catalogue from whenever disk was written.
      note: status.everRanOnline
        ? null
        : 'Nothing has been refreshed over the network in this process yet. What is shown came from the on-disk cache.',
    };
  });

  server.post<{ Body: { force?: boolean } }>('/api/discovery/refresh', async (req) => {
    // Outbound requests on the instance's behalf, to hosts the operator did not
    // name in this request. That is an administrative act.
    requireAdmin(req);
    const status = await app.freeInference.refresh({ force: req.body?.force === true, existingIds: shippedIds });
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'discovery.refresh',
      target: 'free-inference',
      details: { force: req.body?.force === true, sources: status.sources.length },
      ip: req.ip,
    });
    return { status };
  });

  /* ---------------- Free inference ---------------- */

  /**
   * The ranked answer.
   *
   * `includeNonFree` exists so the UI can show the shape of the whole
   * catalogue — how much of it is free, how much is credit, how much is simply
   * not established — because "126 free models" means something different when
   * the other 76 are unknown than when they are known to be paid.
   */
  server.get<{
    Querystring: {
      requires?: string;
      minContext?: string;
      includeNonFree?: string;
      limit?: string;
      providerId?: string;
    };
  }>('/api/discovery/free', async (req) => {
    const q = req.query ?? {};
    const requires = (q.requires ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as (keyof NonNullable<MergedModel['capabilities']>)[];

    const result = app.freeInference.rank({
      now: Date.now(),
      requires: requires.length ? requires : undefined,
      minContext: q.minContext ? Number.parseInt(q.minContext, 10) : undefined,
      includeNonFree: q.includeNonFree === 'true',
    });

    const filtered = q.providerId ? result.models.filter((m) => m.providerId === q.providerId) : result.models;
    const limit = q.limit ? Math.max(1, Math.min(500, Number.parseInt(q.limit, 10))) : 100;

    return {
      models: filtered.slice(0, limit).map((m) => ({
        ...m,
        // The label, not the enum, because "Free daily quota" and
        // "Recurring credit" are the distinction a person needs to see.
        accessLabel: labelFor(app, m.providerId),
      })),
      total: filtered.length,
      returned: Math.min(filtered.length, limit),
      // An empty result must be explicable. Without this the UI can only say
      // "no free models found", which reads as "there are none" rather than
      // "everything was excluded for a reason you can see".
      excluded: result.excluded,
    };
  });

  /* ---------------- Providers ---------------- */

  server.get<{ Querystring: { free?: string } }>('/api/discovery/providers', async (req) => {
    const providers = app.freeInference.providers();
    const onlyFree = req.query?.free === 'true';
    return {
      providers: providers
        .filter((p) => !onlyFree || (p.intelligence && p.intelligence.freeAccess !== 'UNKNOWN' && p.intelligence.freeAccess !== 'PAID_ONLY'))
        .map((p) => ({
          providerId: p.providerId,
          shipped: shippedIds.has(p.providerId),
          registered: Boolean(app.providers.descriptor(p.providerId)),
          freeAccess: p.intelligence?.freeAccess ?? 'UNKNOWN',
          accessLabel: p.intelligence ? freeAccessLabel(p.intelligence.freeAccess) : 'Unknown',
          freeTierSummary: p.intelligence?.freeTierSummary ?? null,
          caveat: p.intelligence?.caveat ?? null,
          requirements: p.intelligence?.requirements ?? null,
          commercialUse: p.intelligence?.commercialUse ?? 'unknown',
          contributors: p.contributors,
          unroutableReason: p.unroutableReason,
          provenance: p.intelligence?.provenance ?? null,
        })),
    };
  });

  /**
   * One provider, with the merge shown.
   *
   * `origins` is the part worth having: it says which source supplied each
   * field and which sources were overruled to get there, so a wrong answer can
   * be traced to the source that supplied it rather than argued about.
   */
  server.get<{ Params: { id: string } }>('/api/discovery/providers/:id', async (req) => {
    const provider = app.freeInference.provider(req.params.id);
    if (!provider) throw new MeridianError('invalid_request', `Discovery knows nothing about "${req.params.id}".`);
    const models = app.freeInference.models().filter((m) => m.providerId === req.params.id);
    return {
      provider: {
        ...provider,
        shipped: shippedIds.has(provider.providerId),
        registered: Boolean(app.providers.descriptor(provider.providerId)),
        // Flattened to match the list route. Two endpoints describing the same
        // thing with the field in two different places is the kind of small
        // inconsistency every caller then has to carry a branch for.
        freeAccess: provider.intelligence?.freeAccess ?? 'UNKNOWN',
        accessLabel: provider.intelligence ? freeAccessLabel(provider.intelligence.freeAccess) : 'Unknown',
      },
      models,
    };
  });

  /* ---------------- Attribution ---------------- */

  /**
   * What is redistributed, under what licence, and who to credit.
   *
   * Served rather than only written in a file, because the data in the product
   * is what is actually being redistributed, and a notices file can drift from
   * it. This one cannot: it is generated from the sources that loaded.
   */
  server.get('/api/discovery/attribution', async () => ({
    sources: app.freeInference.attributions(),
  }));
}

function labelFor(app: App, providerId: string): string {
  const provider = app.freeInference.provider(providerId);
  const kind: FreeAccessKind = provider?.intelligence?.freeAccess ?? 'UNKNOWN';
  return freeAccessLabel(kind);
}
