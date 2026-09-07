import type { ModelChange, ModelDescriptor } from '@meridian/shared';

/**
 * What changed about a model between two discovery passes.
 *
 * Providers move models under stable ids: a context window doubles, vision
 * appears, a model is quietly withdrawn. Without a diff the user finds out by
 * having a request behave differently. Comparing snapshots turns that into an
 * observable event.
 */

/** Fields whose change is worth telling a human about. */
const WATCHED: { field: string; read: (m: ModelDescriptor) => string | null }[] = [
  { field: 'displayName', read: (m) => m.displayName },
  { field: 'contextLength', read: (m) => (m.contextLength == null ? null : String(m.contextLength)) },
  { field: 'maxOutputTokens', read: (m) => (m.maxOutputTokens == null ? null : String(m.maxOutputTokens)) },
  { field: 'capabilities', read: (m) => [...m.capabilities].sort().join(',') || null },
  { field: 'modalities', read: (m) => [...m.modalities].sort().join(',') || null },
  { field: 'pricing.kind', read: (m) => m.pricing.kind },
  { field: 'pricing.inputPerMTok', read: (m) => (m.pricing.inputPerMTok == null ? null : String(m.pricing.inputPerMTok)) },
  { field: 'pricing.outputPerMTok', read: (m) => (m.pricing.outputPerMTok == null ? null : String(m.pricing.outputPerMTok)) },
  { field: 'deprecated', read: (m) => String(m.deprecated) },
];

export function diffModel(previous: ModelDescriptor, next: ModelDescriptor): ModelChange['changes'] {
  const changes: ModelChange['changes'] = [];
  for (const w of WATCHED) {
    const from = w.read(previous);
    const to = w.read(next);
    if (from !== to) changes.push({ field: w.field, from, to });
  }
  return changes;
}

/**
 * Compare a provider's previous model set with the one just discovered.
 *
 * Returns one record per meaningful event. A model whose watched fields are
 * identical produces nothing, which is what keeps the "new models" view from
 * re-announcing the same catalog on every pass.
 */
export function detectChanges(
  previous: ModelDescriptor[],
  next: ModelDescriptor[],
  now: number,
): Omit<ModelChange, 'id'>[] {
  const before = new Map(previous.map((m) => [m.id, m]));
  const after = new Map(next.map((m) => [m.id, m]));
  const out: Omit<ModelChange, 'id'>[] = [];

  for (const [id, model] of after) {
    const prior = before.get(id);
    if (!prior) {
      out.push({
        modelId: id,
        at: now,
        kind: 'discovered',
        changes: [{ field: 'model', from: null, to: model.displayName }],
      });
      continue;
    }
    const changes = diffModel(prior, model);
    if (changes.length) out.push({ modelId: id, at: now, kind: 'updated', changes });
  }

  for (const [id, model] of before) {
    if (!after.has(id)) {
      out.push({ modelId: id, at: now, kind: 'removed', changes: [{ field: 'model', from: model.displayName, to: null }] });
    }
  }

  return out;
}
