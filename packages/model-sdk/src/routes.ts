/**
 * Routes: the same model, reached different ways.
 *
 * A model is not a price. Llama 3.3 70B is served by a dozen providers at
 * different rates, different speeds and different free allowances, and "which
 * model should I use" is really two questions — which weights, and through
 * whom. Everything else in Meridian ranks individual `provider:model` pairs;
 * this groups them so the second question can be answered on its own.
 *
 * The grouping is deliberately conservative. Two entries are treated as the
 * same model only when their identifiers agree after removing the packaging
 * that providers add — the publisher prefix, a quantisation or variant suffix,
 * the `:free` marker aggregators append. When in doubt they stay separate: two
 * genuinely different models shown as one route group would send a request
 * somewhere the caller did not choose, which is far worse than showing one
 * model as two groups.
 */
import { isFree, isZeroCost, type ModelDescriptor, type ProviderHealth } from '@meridian/shared';
import type { ModelView } from './registry.js';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Suffixes providers append to the same underlying weights.
 *
 * Only packaging is listed. A suffix that changes what the model *is* —
 * `-instruct` versus a base model, a distinct parameter count — is never
 * stripped, because those are different models and must not be merged.
 */
const PACKAGING_SUFFIXES = [
  ':free',
  ':nitro',
  ':beta',
  ':extended',
  ':floor',
  '-fp8',
  '-fp16',
  '-bf16',
  '-int8',
  '-int4',
  '-awq',
  '-gptq',
  '-gguf',
  '-turbo-free',
];

/**
 * Reduce a provider's model id to a comparable key.
 *
 * `meta-llama/Llama-3.3-70B-Instruct-Turbo` and
 * `accounts/fireworks/models/llama-v3p3-70b-instruct` do NOT collapse together
 * here, and that is intentional: inferring that they are the same weights takes
 * knowledge this function does not have. What it does reliably is collapse the
 * common case — the same id published with different casing, a publisher
 * prefix, or a packaging suffix.
 */
export function normalizeModelKey(providerModelId: string): string {
  let key = providerModelId.trim().toLowerCase();

  // Drop a publisher/namespace prefix: "meta-llama/llama-3.3-70b" -> the tail.
  const slash = key.lastIndexOf('/');
  if (slash >= 0 && slash < key.length - 1) key = key.slice(slash + 1);

  for (const suffix of PACKAGING_SUFFIXES) {
    if (key.endsWith(suffix)) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }

  // Underscores and spaces are cosmetic between providers. Dots are NOT:
  // "3.3" and "3-3" look interchangeable but a version number is part of the
  // model's identity, and flattening it merges Llama 3.3 with a hypothetical
  // Llama 3 revision 3. Letters, digits and dots survive untouched.
  return key.replace(/[_\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ */
/* Route options                                                       */
/* ------------------------------------------------------------------ */

export interface RouteOption {
  /** Meridian's `provider:model` id. */
  modelId: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  /** True when a call cannot draw down money. */
  free: boolean;
  /**
   * Blended USD per 1M tokens, assuming 3:1 input:output.
   *
   * Null when the provider publishes no rates — which is not the same as free,
   * and must not be sorted as though it were zero.
   */
  blendedPerMTok: number | null;
  contextLength: number | null;
  local: boolean;
  /** Measured, not assumed. Null until something has been observed. */
  latencyMs: number | null;
  p95LatencyMs: number | null;
  /** Observed successes / attempts, [0,1]. Null when never exercised. */
  reliability: number | null;
  health: ProviderHealth['state'];
  /** Whether the provider is usable right now, in the registry's words. */
  supportState: string;
  /** Free-access classification from the synced catalog, when known. */
  freeAccess: string | null;
  /** True when the operator has a credential for this provider. */
  configured: boolean;
}

export interface RouteGroup {
  key: string;
  displayName: string;
  options: RouteOption[];
  /** Cheapest option with a KNOWN price. Null when no price is published. */
  cheapest: RouteOption | null;
  /** A route that costs nothing at the moment of the call. */
  freeRoute: RouteOption | null;
  /** Fastest by measured p95. Null when nothing has been measured. */
  fastest: RouteOption | null;
  /** Runs on the operator's own hardware. */
  localRoute: RouteOption | null;
}

export interface RouteContext {
  view: (modelId: string) => ModelView | null;
  health: (providerId: string) => ProviderHealth | null;
  supportState: (providerId: string) => string;
  configured: (providerId: string) => boolean;
  /** Free-access kind from the synced catalog, when the dataset covers it. */
  freeAccess?: (providerId: string) => string | null;
  local?: (providerId: string) => boolean;
}

/**
 * Blended token price.
 *
 * A single comparable number is needed to sort routes, and comparing input
 * rates alone rewards providers that load their cost onto output. 3:1 is the
 * usual shape of a chat workload; it is an assumption, and it is named here
 * rather than hidden so a caller can disagree with it.
 */
export function blendedPerMTok(m: ModelDescriptor): number | null {
  const { inputPerMTok: i, outputPerMTok: o } = m.pricing;
  if (i == null && o == null) return isFree(m.pricing) ? 0 : null;
  const input = i ?? o ?? 0;
  const output = o ?? i ?? 0;
  return (input * 3 + output) / 4;
}

function toOption(m: ModelDescriptor, ctx: RouteContext): RouteOption {
  const view = ctx.view(m.id);
  const health = ctx.health(m.providerId);
  return {
    modelId: m.id,
    providerId: m.providerId,
    providerModelId: m.providerModelId,
    displayName: m.displayName,
    free: isFree(m.pricing),
    blendedPerMTok: blendedPerMTok(m),
    contextLength: m.contextLength,
    local: ctx.local?.(m.providerId) ?? m.pricing.kind === 'LOCAL',
    latencyMs: view?.performance?.latencyMs ?? null,
    p95LatencyMs: view?.performance?.p95LatencyMs ?? null,
    reliability: view?.scores?.stability ?? null,
    health: health?.state ?? 'unknown',
    supportState: ctx.supportState(m.providerId),
    freeAccess: ctx.freeAccess?.(m.providerId) ?? null,
    configured: ctx.configured(m.providerId),
  };
}

/**
 * Group every model into routes.
 *
 * Groups with a single option are kept: "this model is available exactly one
 * way" is a real and useful answer, and dropping them would make the view lie
 * about what is reachable.
 */
export function groupRoutes(models: ModelDescriptor[], ctx: RouteContext): RouteGroup[] {
  const groups = new Map<string, ModelDescriptor[]>();
  for (const m of models) {
    const key = normalizeModelKey(m.providerModelId);
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }

  const out: RouteGroup[] = [];
  for (const [key, members] of groups) {
    const options = members.map((m) => toOption(m, ctx));

    // Only options with a published price can be compared on price. A null
    // rate sorted as zero would crown an unknown-cost route "cheapest".
    const priced = options.filter((o) => o.blendedPerMTok !== null);
    const cheapest =
      priced.length > 0
        ? priced.reduce((a, b) => (b.blendedPerMTok! < a.blendedPerMTok! ? b : a))
        : null;

    const measured = options.filter((o) => o.p95LatencyMs !== null);
    const fastest =
      measured.length > 0 ? measured.reduce((a, b) => (b.p95LatencyMs! < a.p95LatencyMs! ? b : a)) : null;

    // Prefer a route the operator can actually use right now.
    const freeCandidates = options.filter(
      (o) => o.free || (o.freeAccess !== null && isZeroCost(o.freeAccess as never)),
    );
    const freeRoute =
      freeCandidates.find((o) => o.configured) ?? freeCandidates[0] ?? null;

    const localCandidates = options.filter((o) => o.local);
    const localRoute = localCandidates.find((o) => o.configured) ?? localCandidates[0] ?? null;

    out.push({
      key,
      displayName: members[0]?.displayName ?? key,
      options: options.sort(byPreferability),
      cheapest,
      freeRoute,
      fastest,
      localRoute,
    });
  }

  // Most-routed models first: those are the ones where the choice matters.
  return out.sort((a, b) => b.options.length - a.options.length || a.key.localeCompare(b.key));
}

/**
 * Within a group, show what someone would most likely pick first: usable
 * routes above unusable ones, free above paid, then cheaper, then faster.
 */
function byPreferability(a: RouteOption, b: RouteOption): number {
  if (a.configured !== b.configured) return a.configured ? -1 : 1;
  if (a.free !== b.free) return a.free ? -1 : 1;
  const ap = a.blendedPerMTok;
  const bp = b.blendedPerMTok;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  const al = a.p95LatencyMs ?? a.latencyMs;
  const bl = b.p95LatencyMs ?? b.latencyMs;
  if (al !== null && bl !== null && al !== bl) return al - bl;
  return a.providerId.localeCompare(b.providerId);
}

/** Only the groups where there is genuinely a choice to make. */
export function multiRouteGroups(groups: RouteGroup[]): RouteGroup[] {
  return groups.filter((g) => g.options.length > 1);
}

/* ------------------------------------------------------------------ */
/* Free AI radar                                                       */
/* ------------------------------------------------------------------ */

export interface RadarEntry {
  option: RouteOption;
  /** [0,100]. Higher is a better free option right now. */
  score: number;
  /** Why it scored what it did, for display. Never a black box. */
  factors: { quality: number; reliability: number; availability: number; speed: number };
  /** Plain-language reason this is or is not usable today. */
  note: string;
}

export interface RadarOptions {
  /** Measured quality in [0,100] for the task at hand. */
  quality: (modelId: string) => number;
  /** Include routes with no credential, marked as needing setup. */
  includeUnconfigured?: boolean;
  limit?: number;
}

/**
 * Rank the free options.
 *
 * Answers "what is the strongest thing I can use for nothing right now",
 * which is a different question from "what is the best model" — availability
 * and reliability count for as much as raw quality when the budget is zero.
 *
 * Two rules keep it honest. Only zero-cost access qualifies, so trial credit
 * never appears here; and an unmeasured model scores from a neutral prior
 * rather than a flattering one, so nothing climbs the list merely by never
 * having been tried.
 */
export function freeRadar(groups: RouteGroup[], opts: RadarOptions): RadarEntry[] {
  const seen = new Set<string>();
  const entries: RadarEntry[] = [];

  for (const g of groups) {
    for (const o of g.options) {
      if (seen.has(o.modelId)) continue;
      const zeroCost = o.free || (o.freeAccess !== null && isZeroCost(o.freeAccess as never));
      if (!zeroCost) continue;
      if (!o.configured && !opts.includeUnconfigured) continue;
      seen.add(o.modelId);

      const quality = clamp01(opts.quality(o.modelId) / 100);
      // A neutral prior, explicitly: never observed is not the same as good.
      const reliability = o.reliability ?? 0.75;
      const availability =
        o.health === 'healthy' ? 1 : o.health === 'unknown' ? 0.7 : o.health === 'degraded' ? 0.4 : 0.1;
      // 2s is treated as par; faster earns a little, slower loses a little.
      const p95 = o.p95LatencyMs ?? o.latencyMs;
      const speed = p95 === null ? 0.6 : clamp01(2000 / Math.max(250, p95));

      const score =
        Math.round(
          (quality * 0.4 + reliability * 0.25 + availability * 0.25 + speed * 0.1) * 1000,
        ) / 10;

      entries.push({
        option: o,
        score,
        factors: {
          quality: round2(quality),
          reliability: round2(reliability),
          availability: round2(availability),
          speed: round2(speed),
        },
        note: describeUsability(o),
      });
    }
  }

  entries.sort((a, b) => b.score - a.score || a.option.modelId.localeCompare(b.option.modelId));
  return opts.limit ? entries.slice(0, opts.limit) : entries;
}

function describeUsability(o: RouteOption): string {
  if (!o.configured) return 'Needs an API key before it can be used.';
  if (o.health === 'rate_limited') return 'Rate limited right now.';
  if (o.health === 'offline') return 'Not responding.';
  if (o.health === 'degraded') return 'Responding, but with errors.';
  if (o.local) return 'Runs on this machine — no API cost.';
  if (o.reliability === null) return 'Ready. Not yet exercised, so reliability is unmeasured.';
  return 'Ready.';
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
