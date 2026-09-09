/**
 * The merge: many sources, one answer, and a record of where it came from.
 *
 * `SOURCE_PRECEDENCE` and the confidence ladder existed as tables that nothing
 * consulted. This is what consults them.
 *
 * The rules, in the order they are applied to any single field:
 *
 *  1. **A source may only contribute what it declared.** `contributes` is not
 *     documentation. A price book that starts publishing a `card_required`
 *     field does not thereby acquire an opinion on signup terms, and a model
 *     list that mentions a rate limit does not get to set the rate card. This
 *     is checked per field, not per source, because the alternative is that one
 *     source's schema change silently rewrites another's data.
 *
 *  2. **Source class beats confidence.** A provider's own API saying a model
 *     exists outranks a well-maintained dataset saying it does not, because
 *     proximity to the truth beats care taken with second-hand information.
 *
 *  3. **Within a class, confidence decides**, after age has been applied. A
 *     claim nobody has rechecked in three months is not evidence about today.
 *
 *  4. **A tie leaves the incumbent.** Two equal claims are not a reason to
 *     churn; the first one recorded stays, so a merge is stable across runs and
 *     the UI does not show a field flickering between two identical answers.
 *
 * And one rule that overrides all four:
 *
 *  5. **Unknown never becomes free.** Merging is allowed to make an answer more
 *     specific. It is never allowed to invent one. If no source with standing
 *     said a thing is free, the answer is UNKNOWN, and UNKNOWN is excluded from
 *     every "free" filter rather than included in it.
 */
import type { Pricing, ProviderDescriptor, ProviderIntelligence } from '@meridian/shared';
import {
  confidenceRank,
  sourceRank,
  type Contribution,
  type DiscoveryContext,
  type DiscoverySource,
  type SourceMetadata,
  type SourceModelFacts,
  type SourceSnapshot,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Standing                                                            */
/* ------------------------------------------------------------------ */

/**
 * How much weight one source's claim about one field carries.
 *
 * Source class dominates, and confidence breaks ties within a class — hence
 * the multiplier, which is wide enough that no amount of confidence promotes a
 * community catalogue above a provider's own answer.
 */
export function claimStanding(metadata: SourceMetadata, confidence: Parameters<typeof confidenceRank>[0]): number {
  return sourceRank(metadata.sourceClass) * 100 + confidenceRank(confidence);
}

export function mayContribute(metadata: SourceMetadata, field: Contribution): boolean {
  return metadata.contributes.includes(field);
}

/* ------------------------------------------------------------------ */
/* What a merge produced, and why                                      */
/* ------------------------------------------------------------------ */

/** One field's winning claim, and what it beat. */
export interface FieldOrigin {
  field: string;
  sourceId: string;
  sourceClass: SourceMetadata['sourceClass'];
  confidence: string;
  standing: number;
  /** Sources that claimed this field and lost, with why. */
  overruled: { sourceId: string; standing: number }[];
}

export interface MergedProvider {
  providerId: string;
  descriptor: ProviderDescriptor | null;
  intelligence: ProviderIntelligence | null;
  /** Every source that said anything about this provider. */
  contributors: string[];
  origins: FieldOrigin[];
  unroutableReason: string | null;
}

export interface MergedModel extends SourceModelFacts {
  contributors: string[];
  origins: FieldOrigin[];
}

export interface MergeResult {
  providers: MergedProvider[];
  models: MergedModel[];
  /** Per-source outcome, for the status UI. */
  sources: {
    id: string;
    displayName: string;
    sourceClass: SourceMetadata['sourceClass'];
    ok: boolean;
    fromCache: boolean;
    cacheAgeDays: number | null;
    providers: number;
    models: number;
    error: string | null;
    attribution: string;
    license: string;
  }[];
  /** Claims dropped because the source had no standing to make them. */
  refusals: { sourceId: string; field: Contribution; count: number }[];
}

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

export class DiscoveryRegistry {
  private readonly sources: DiscoverySource[] = [];

  register(source: DiscoverySource): this {
    if (this.sources.some((s) => s.metadata.id === source.metadata.id)) {
      throw new Error(`A discovery source with the id "${source.metadata.id}" is already registered.`);
    }
    this.sources.push(source);
    return this;
  }

  registerAll(sources: DiscoverySource[]): this {
    for (const s of sources) this.register(s);
    return this;
  }

  list(): readonly SourceMetadata[] {
    return this.sources.map((s) => s.metadata);
  }

  /**
   * Load every source and merge the results.
   *
   * Sources load concurrently and independently: one being down must not delay
   * or fail the others, which is why `load` is contracted never to throw and
   * why a rejection here is still turned into a reportable empty snapshot
   * rather than being allowed to escape.
   */
  async load(ctx: DiscoveryContext): Promise<MergeResult> {
    const snapshots = await Promise.all(
      this.sources.map(async (source): Promise<SourceSnapshot> => {
        try {
          return await source.load(ctx);
        } catch (error) {
          return {
            metadata: source.metadata,
            version: null,
            generated: null,
            fetchedAt: ctx.now,
            fromCache: false,
            cacheAgeDays: null,
            providers: [],
            models: [],
            error: `The source threw instead of reporting: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    );
    return mergeSnapshots(snapshots);
  }
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

interface Claim<T> {
  value: T;
  standing: number;
  sourceId: string;
  sourceClass: SourceMetadata['sourceClass'];
  confidence: string;
}

/** Take the stronger claim; on a tie, keep the incumbent so merges are stable. */
function resolve<T>(current: Claim<T> | null, next: Claim<T>): { winner: Claim<T>; loser: Claim<T> | null } {
  if (!current) return { winner: next, loser: null };
  return next.standing > current.standing ? { winner: next, loser: current } : { winner: current, loser: next };
}

export function mergeSnapshots(snapshots: SourceSnapshot[]): MergeResult {
  const refusals = new Map<string, { sourceId: string; field: Contribution; count: number }>();
  const refuse = (sourceId: string, field: Contribution) => {
    const key = `${sourceId}:${field}`;
    const existing = refusals.get(key);
    if (existing) existing.count += 1;
    else refusals.set(key, { sourceId, field, count: 1 });
  };

  /* ---------------- Providers ---------------- */

  interface ProviderAccumulator {
    providerId: string;
    descriptor: Claim<ProviderDescriptor> | null;
    intelligence: Claim<ProviderIntelligence> | null;
    contributors: Set<string>;
    origins: Map<string, FieldOrigin>;
    unroutableReason: string | null;
  }
  const providers = new Map<string, ProviderAccumulator>();

  const note = (acc: { origins: Map<string, FieldOrigin> }, field: string, winner: Claim<unknown>, loser: Claim<unknown> | null) => {
    const existing = acc.origins.get(field);
    const overruled = existing ? [...existing.overruled] : [];
    if (loser) overruled.push({ sourceId: loser.sourceId, standing: loser.standing });
    acc.origins.set(field, {
      field,
      sourceId: winner.sourceId,
      sourceClass: winner.sourceClass,
      confidence: winner.confidence,
      standing: winner.standing,
      overruled,
    });
  };

  for (const snapshot of snapshots) {
    const meta = snapshot.metadata;
    for (const entry of snapshot.providers) {
      let acc = providers.get(entry.providerId);
      if (!acc) {
        acc = {
          providerId: entry.providerId,
          descriptor: null,
          intelligence: null,
          contributors: new Set(),
          origins: new Map(),
          unroutableReason: entry.unroutableReason,
        };
        providers.set(entry.providerId, acc);
      }
      acc.contributors.add(meta.id);

      if (entry.descriptor) {
        if (!mayContribute(meta, 'providers')) {
          refuse(meta.id, 'providers');
        } else {
          const claim: Claim<ProviderDescriptor> = {
            value: entry.descriptor,
            standing: claimStanding(meta, meta.baseConfidence),
            sourceId: meta.id,
            sourceClass: meta.sourceClass,
            confidence: meta.baseConfidence,
          };
          const { winner, loser } = resolve(acc.descriptor, claim);
          acc.descriptor = winner;
          note(acc, 'descriptor', winner, loser);
        }
      }

      if (entry.intelligence) {
        if (!mayContribute(meta, 'access-terms')) {
          refuse(meta.id, 'access-terms');
        } else {
          const claim: Claim<ProviderIntelligence> = {
            value: entry.intelligence,
            standing: claimStanding(meta, meta.baseConfidence),
            sourceId: meta.id,
            sourceClass: meta.sourceClass,
            confidence: meta.baseConfidence,
          };
          const { winner, loser } = resolve(acc.intelligence, claim);
          acc.intelligence = winner;
          note(acc, 'intelligence', winner, loser);
        }
      }

      // A descriptor from anywhere makes the provider routable, so the reason
      // it was not is only kept while it still is not.
      if (acc.descriptor) acc.unroutableReason = null;
      else if (!acc.unroutableReason) acc.unroutableReason = entry.unroutableReason;
    }
  }

  /* ---------------- Models ---------------- */

  interface ModelAccumulator {
    base: SourceModelFacts;
    pricing: Claim<Pricing> | null;
    contextLength: Claim<number> | null;
    maxOutputTokens: Claim<number> | null;
    capabilities: Map<string, Claim<boolean>>;
    contributors: Set<string>;
    origins: Map<string, FieldOrigin>;
  }
  const models = new Map<string, ModelAccumulator>();

  for (const snapshot of snapshots) {
    const meta = snapshot.metadata;
    for (const facts of snapshot.models) {
      if (!mayContribute(meta, 'models')) {
        refuse(meta.id, 'models');
        continue;
      }
      let acc = models.get(facts.modelId);
      if (!acc) {
        acc = {
          base: facts,
          pricing: null,
          contextLength: null,
          maxOutputTokens: null,
          capabilities: new Map(),
          contributors: new Set(),
          origins: new Map(),
        };
        models.set(facts.modelId, acc);
      }
      acc.contributors.add(meta.id);
      const base = claimStanding(meta, facts.confidence);
      const claimOf = <T>(value: T): Claim<T> => ({
        value,
        standing: base,
        sourceId: meta.id,
        sourceClass: meta.sourceClass,
        confidence: facts.confidence,
      });

      if (facts.pricing !== undefined) {
        if (!mayContribute(meta, 'pricing') && !facts.pricing.freeQuota) {
          // A source entitled to quota but not to rates may still say "15 rpm";
          // it may not say what a token costs.
          refuse(meta.id, 'pricing');
        } else if (!mayContribute(meta, 'pricing') && facts.pricing.freeQuota) {
          if (mayContribute(meta, 'quota')) {
            const quotaOnly: Pricing = { kind: 'UNKNOWN', inputPerMTok: null, outputPerMTok: null, perRequest: null, freeQuota: facts.pricing.freeQuota };
            const { winner, loser } = resolve(acc.pricing, claimOf(quotaOnly));
            acc.pricing = winner;
            note(acc, 'pricing.freeQuota', winner, loser);
          } else {
            refuse(meta.id, 'quota');
          }
        } else {
          const { winner, loser } = resolve(acc.pricing, claimOf(facts.pricing));
          acc.pricing = winner;
          note(acc, 'pricing', winner, loser);
        }
      }

      if (facts.contextLength !== undefined && facts.contextLength !== null) {
        if (!mayContribute(meta, 'limits')) refuse(meta.id, 'limits');
        else {
          const { winner, loser } = resolve(acc.contextLength, claimOf(facts.contextLength));
          acc.contextLength = winner;
          note(acc, 'contextLength', winner, loser);
        }
      }

      if (facts.maxOutputTokens !== undefined && facts.maxOutputTokens !== null) {
        if (!mayContribute(meta, 'limits')) refuse(meta.id, 'limits');
        else {
          const { winner, loser } = resolve(acc.maxOutputTokens, claimOf(facts.maxOutputTokens));
          acc.maxOutputTokens = winner;
          note(acc, 'maxOutputTokens', winner, loser);
        }
      }

      if (facts.capabilities) {
        if (!mayContribute(meta, 'capabilities')) {
          refuse(meta.id, 'capabilities');
        } else {
          for (const [name, value] of Object.entries(facts.capabilities)) {
            if (value === undefined) continue;
            const { winner, loser } = resolve(acc.capabilities.get(name) ?? null, claimOf(value));
            acc.capabilities.set(name, winner);
            note(acc, `capabilities.${name}`, winner, loser);
          }
        }
      }

      // The strongest claim about the model as a whole decides which
      // provenance is shown, so the citation matches the data it cites.
      if (base > claimStanding(meta, acc.base.confidence) || acc.contributors.size === 1) {
        acc.base = { ...acc.base, provenance: facts.provenance, confidence: facts.confidence };
      }
    }
  }

  return {
    providers: [...providers.values()].map((acc) => ({
      providerId: acc.providerId,
      descriptor: acc.descriptor?.value ?? null,
      intelligence: acc.intelligence?.value ?? null,
      contributors: [...acc.contributors].sort(),
      origins: [...acc.origins.values()],
      unroutableReason: acc.unroutableReason,
    })),
    models: [...models.values()].map((acc) => {
      const capabilities: NonNullable<SourceModelFacts['capabilities']> = {};
      for (const [name, claim] of acc.capabilities) {
        (capabilities as Record<string, boolean>)[name] = claim.value;
      }
      return {
        ...acc.base,
        pricing: acc.pricing?.value,
        contextLength: acc.contextLength?.value ?? null,
        maxOutputTokens: acc.maxOutputTokens?.value ?? null,
        capabilities: Object.keys(capabilities).length ? capabilities : undefined,
        contributors: [...acc.contributors].sort(),
        origins: [...acc.origins.values()],
      };
    }),
    sources: snapshots.map((s) => ({
      id: s.metadata.id,
      displayName: s.metadata.displayName,
      sourceClass: s.metadata.sourceClass,
      ok: s.error === null,
      fromCache: s.fromCache,
      cacheAgeDays: s.cacheAgeDays,
      providers: s.providers.length,
      models: s.models.length,
      error: s.error,
      attribution: s.metadata.attribution,
      license: s.metadata.license,
    })),
    refusals: [...refusals.values()].sort((a, b) => b.count - a.count),
  };
}
