import type { ModelView } from './api.js';

/**
 * Curate the best free and low-cost chat models out of live discovery.
 *
 * This is what feeds the model menu in the composer. It never invents an
 * entry: everything here came from a provider listing Meridian actually
 * fetched, filtered to models that could serve a chat request right now, and
 * ranked with the same recommendation score the Models screen shows — so the
 * menu is the discovery pipeline made convenient, not a second opinion.
 */

export interface ModelPick {
  model: ModelView;
  /** What running it costs, as a person would say it: "Free", "Local", "$0.25/M". */
  priceLabel: string;
  free: boolean;
}

/**
 * Output price, in $/M tokens, up to which a metered model still counts as
 * "low-cost". Above it a model can be excellent, but it does not belong in a
 * menu whose promise is that anything on it is cheap to try.
 */
export const LOW_COST_CEILING_PER_MTOK = 1.5;

function priceLabel(m: ModelView): string {
  if (m.pricing.kind === 'LOCAL') return 'Local';
  if (m.free) return 'Free';
  const out = (m.pricing as { outputPerMTok?: number | null }).outputPerMTok;
  return out != null ? `$${out < 0.1 ? out.toFixed(3) : out.toFixed(2)}/M` : 'Metered';
}

/** Can this model plausibly answer a chat message right now? */
function usable(m: ModelView): boolean {
  if (!(m.modalities ?? []).includes('text')) return false;
  if (m.deprecated) return false;
  if (m.status === 'offline') return false;
  if (m.supportState === 'unavailable') return false;
  return true;
}

/**
 * The menu, best first.
 *
 * Free and local models lead — the product's economics promise — ordered by
 * recommendation score so "best free" means best, not first-listed. Low-cost
 * metered models follow, cheapest tier ordered by the same score. Everything
 * pricier is left to the Models screen.
 */
export function bestPicks(models: ModelView[], limit = 9): ModelPick[] {
  const score = (m: ModelView): number => m.recommendation?.score ?? 0;

  const freebies = models
    .filter(usable)
    .filter((m) => m.free)
    .sort((a, b) => score(b) - score(a) || (b.contextLength ?? 0) - (a.contextLength ?? 0));

  const cheap = models
    .filter(usable)
    .filter((m) => !m.free)
    .filter((m) => {
      const out = (m.pricing as { outputPerMTok?: number | null }).outputPerMTok;
      return out != null && out <= LOW_COST_CEILING_PER_MTOK;
    })
    .sort((a, b) => score(b) - score(a));

  return [...freebies, ...cheap].slice(0, limit).map((model) => ({
    model,
    priceLabel: priceLabel(model),
    free: model.free,
  }));
}
