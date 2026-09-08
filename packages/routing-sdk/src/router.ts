import {
  MeridianError,
  capabilityConfidence,
  costScore,
  describeCost,
  estimateCall,
  estimatePromptTokens,
  fitsLimit,
  isFree,
  mayCharge,
  type AIRequest,
  type CallEstimate,
  type Capability,
  type Modality,
  type ModelDescriptor,
  type PrivacyMode,
  type RoutingCandidate,
  type RoutingDecision,
  type RoutingMode,
  type RoutingReason,
  type RoutingSnapshot,
  type UserPreferences,
} from '@meridian/shared';
import { ModelRegistry, recommendationScore } from '@meridian/model-sdk';
import type { ProviderRegistry } from '@meridian/provider-sdk';
import type { CredentialResolver } from './credentials.js';
import type { HealthStore } from './health.js';
import type { PoolManager } from './pools.js';
import {
  MODE_WEIGHTS,
  PRIVACY_TRUST,
  STRICTLY_FREE_MODES,
  STRICTLY_LOCAL_MODES,
  canonicalMode,
  type ModeWeights,
} from './policy.js';

export interface RouterDeps {
  models: ModelRegistry;
  providers: ProviderRegistry;
  health: HealthStore;
  credentials: CredentialResolver;
  pools: PoolManager;
  /** Global kill-switch: when false no request may route to a paid model. */
  allowPaid: () => boolean;
  preferencesFor?: (userId: string | null | undefined) => UserPreferences | null;
  now?: () => number;
}

export interface RouterOptions {
  /** How many alternates to put in the fallback chain. */
  fallbackDepth?: number;
  /** Weight overrides for CUSTOM mode. */
  customWeights?: Partial<ModeWeights>;
}

interface Rejection {
  modelId: string;
  reason: string;
}

/** Capabilities a modality cannot be served without. */
const REQUIRED_FOR_MODALITY: Partial<Record<Modality, Capability>> = {
  image: 'image-generation',
  video: 'video-generation',
  speech: 'speech-synthesis',
  transcription: 'transcription',
  embedding: 'embedding',
  vision: 'vision',
};

/** Which adapter method a modality needs. Enforces "no fake support" at routing time. */
const ADAPTER_METHOD_FOR_MODALITY: Record<Modality, keyof AdapterMethodProbe> = {
  text: 'chat',
  vision: 'chat',
  image: 'image',
  video: 'video',
  speech: 'speech',
  transcription: 'transcribe',
  audio: 'speech',
  embedding: 'embed',
};

interface AdapterMethodProbe {
  chat: unknown;
  image: unknown;
  video: unknown;
  speech: unknown;
  transcribe: unknown;
  embed: unknown;
}

/**
 * The routing engine.
 *
 * Selection is two-phase. First, hard constraints remove every candidate that
 * *cannot* serve the request — wrong modality, missing capability, unavailable
 * provider, disallowed trust level, no credential, over budget. Nothing that
 * survives phase one is a wrong answer; a wrong answer here is a bug, not a
 * ranking miss. Second, the survivors are scored by the mode's weights.
 *
 * Every rejection is recorded with its rule so the "Why this model?" panel can
 * explain not just what was chosen but what was ruled out and why.
 */
export class Router {
  private readonly deps: RouterDeps;
  private readonly opts: Required<Pick<RouterOptions, 'fallbackDepth'>> & RouterOptions;
  private readonly now: () => number;

  constructor(deps: RouterDeps, opts: RouterOptions = {}) {
    this.deps = deps;
    this.opts = { fallbackDepth: 3, ...opts };
    this.now = deps.now ?? (() => Date.now());
  }

  route(req: AIRequest): RoutingDecision {
    const prefs = this.deps.preferencesFor?.(req.userId) ?? null;
    const requestedMode = req.mode ?? prefs?.routingMode ?? 'AUTO';
    const mode = canonicalMode(requestedMode);
    const privacy = req.privacyMode ?? prefs?.privacyMode ?? 'TRUSTED_ONLY';
    const rejected: Rejection[] = [];

    // A pool's own strategy overrides the caller's mode: choosing a pool is
    // choosing a policy.
    const effectiveMode = req.pool ? this.deps.pools.strategyOf(req.pool, mode) : mode;

    const pool = req.pool ?? null;
    const universe = this.universe(req, pool, rejected);
    // A pool's strategy may re-weight the scoring, but it must never dissolve a
    // hard guarantee the caller asked for by mode: FREE through a QUALITY_FIRST
    // pool is still strictly free. Both modes gate; the pool only ranks.
    const eligible = universe.filter(
      (m) =>
        this.passesHardConstraints(m, req, mode, privacy, prefs, rejected) &&
        (effectiveMode === mode || this.passesHardConstraints(m, req, effectiveMode, privacy, prefs, rejected)),
    );

    if (!eligible.length) {
      throw new MeridianError('no_candidates', this.explainEmpty(req, effectiveMode, privacy, rejected), {
        details: { rejected: rejected.slice(0, 25), mode: effectiveMode, privacyMode: privacy },
      });
    }

    const weights = this.weightsFor(effectiveMode);
    // Explicitly preferred candidates rank first, then by score within each
    // group. A preference is an instruction the operator typed, not a hint, so
    // it is not left to be outvoted by a learned average — a model that has
    // simply been measured recently should not silently displace the provider
    // someone asked for. Hard constraints have already removed anything
    // unusable, so this only reorders candidates that could all serve, and the
    // rest of the list stays behind it as the fallback chain.
    const scored = eligible
      .map((m) => this.score(m, req, weights, pool, prefs))
      .sort((a, b) => Number(b.preferred ?? false) - Number(a.preferred ?? false) || b.score - a.score);

    const winner = scored[0];
    const winnerModel = this.deps.models.get(winner.modelId)!;
    const credential = this.credentialFor(winnerModel, req);

    return {
      provider: winner.providerId,
      model: winnerModel.providerModelId,
      credential: credential.credentialId,
      pool,
      fallbackChain: this.buildFallbackChain(scored, req, winner),
      routingReason: this.explain(winner, winnerModel, scored, rejected, effectiveMode, requestedMode, credential.reason, req),
      expectedCost: winner.estimatedCost,
      expectedLatency: winner.estimatedLatencyMs,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Phase 0: the candidate universe                                  */
  /* ---------------------------------------------------------------- */

  private universe(req: AIRequest, pool: string | null, rejected: Rejection[]): ModelDescriptor[] {
    // An explicitly pinned model bypasses ranking but not the hard constraints:
    // the user gets what they asked for, or a clear reason why they cannot.
    if (req.model) {
      const matches = this.deps.models.resolve(req.model);
      if (!matches.length) {
        throw new MeridianError('model_unavailable', `No model matches "${req.model}"`, { modelId: req.model });
      }
      return req.provider ? matches.filter((m) => m.providerId === req.provider) : matches;
    }

    let candidates = this.deps.models.all();

    if (req.provider) {
      candidates = candidates.filter((m) => m.providerId === req.provider);
      if (!candidates.length) {
        throw new MeridianError('provider_unavailable', `Provider "${req.provider}" has no known models`, {
          providerId: req.provider,
        });
      }
    }

    if (pool) {
      const { modelIds, unconstrained } = this.deps.pools.eligibleModels(pool);
      if (!unconstrained) {
        const allowed = new Set(modelIds);
        const before = candidates.length;
        candidates = candidates.filter((m) => allowed.has(m.id));
        if (!candidates.length && before > 0) {
          rejected.push({ modelId: '*', reason: `No model in pool "${pool}" is currently known to the registry` });
        }
      }
    }

    return candidates;
  }

  /* ---------------------------------------------------------------- */
  /* Phase 1: hard constraints                                        */
  /* ---------------------------------------------------------------- */

  private passesHardConstraints(
    m: ModelDescriptor,
    req: AIRequest,
    mode: RoutingMode,
    privacy: PrivacyMode,
    prefs: UserPreferences | null,
    rejected: Rejection[],
  ): boolean {
    const no = (reason: string): false => {
      rejected.push({ modelId: m.id, reason });
      return false;
    };

    if (m.deprecated) return no('Model is deprecated');

    // Modality and capability.
    if (!m.modalities.includes(req.modality)) return no(`Does not serve ${req.modality}`);
    const need = REQUIRED_FOR_MODALITY[req.modality];
    if (need && !m.capabilities.includes(need)) return no(`Missing the ${need} capability`);
    for (const cap of req.requiredCapabilities ?? []) {
      if (!m.capabilities.includes(cap)) return no(`Missing the ${cap} capability`);
    }
    if (req.toolsRequired && !m.capabilities.includes('tools')) return no('Does not support tool calling');
    if (req.reasoningRequired && !m.capabilities.includes('reasoning')) return no('Not a reasoning model');
    if (req.visionRequired && !m.capabilities.includes('vision')) return no('Does not accept images');
    if (req.contextLength != null && (m.contextLength ?? 0) < req.contextLength) {
      return no(`Context window ${m.contextLength ?? 'unknown'} is smaller than the required ${req.contextLength}`);
    }

    // The provider must exist, have an adapter, and implement this modality.
    const descriptor = this.deps.providers.descriptor(m.providerId);
    if (!descriptor) return no('Provider is not registered');
    const support = this.deps.providers.supportState(m.providerId);
    if (support === 'unavailable') return no('No adapter is implemented for this provider');
    const adapter = this.deps.providers.get(m.providerId);
    if (!adapter) return no('Provider adapter could not be constructed');
    const method = ADAPTER_METHOD_FOR_MODALITY[req.modality];
    if (typeof (adapter as unknown as AdapterMethodProbe)[method] !== 'function') {
      return no(`Adapter does not implement ${req.modality}`);
    }

    // Health: an open circuit means the provider is already known to be failing.
    if (!this.deps.health.isAvailable(m.providerId)) {
      const secs = this.deps.health.cooldownRemaining(m.providerId);
      return no(secs ? `Provider is cooling down for another ${secs}s` : 'Provider circuit is open');
    }

    // Privacy and trust.
    const allowedTrust = PRIVACY_TRUST[privacy];
    if (privacy === 'STRICT_LOCAL' && !descriptor.local) return no('Strict-local mode allows only local providers');
    if (privacy !== 'STRICT_LOCAL' && !descriptor.local && !allowedTrust.includes(descriptor.trust)) {
      return no(`Provider trust "${descriptor.trust}" is not permitted under ${privacy}`);
    }
    // Sensitive payloads never reach a provider whose handling is unknown,
    // regardless of the privacy mode's general permissiveness.
    if (req.sensitive && !descriptor.local && (descriptor.trust === 'unknown' || descriptor.trust === 'untrusted')) {
      return no('Request is marked sensitive and this provider is not verified or trusted');
    }

    // Locality.
    if (req.localOnly && !descriptor.local) return no('Request is local-only');
    if (STRICTLY_LOCAL_MODES.includes(mode) && !descriptor.local) return no(`${mode} allows only local models`);

    // Economics. Nothing here ever spends money implicitly.
    const free = isFree(m.pricing);
    if (req.freeOnly && !free) return no('Request is free-only and this model can charge');
    if (STRICTLY_FREE_MODES.includes(mode) && !free) return no(`${mode} allows only models that cannot charge`);
    const estimate = this.estimateCall(m, req);
    if (mayCharge(m.pricing)) {
      const permitted = req.allowPaid ?? prefs?.allowPaid ?? false;
      if (!this.deps.allowPaid()) return no('Paid routing is disabled for this instance');
      if (!permitted) return no('Paid routing requires explicit permission');

      // A limit the caller set has to actually bind. An unpublished rate used
      // to estimate $0 and therefore satisfied every budget ever set, which is
      // the precise shape of spending money the caller thought they had
      // capped — so a price that cannot be computed cannot clear a limit.
      for (const [limit, label] of [
        [req.budget, 'the request budget'],
        [prefs?.maxCostPerTask, 'your per-task cap'],
      ] as const) {
        if (limit == null) continue;
        const verdict = fitsLimit(estimate, limit);
        if (!verdict.fits) return no(`${verdict.reason} for ${label}`);
      }
    }

    // Pool capacity and budget. A pool with a budget is a limit like any other,
    // so an uncomputable cost cannot be charged against it either.
    if (req.pool) {
      const block = this.deps.pools.capacityBlock(req.pool, estimate.usd, estimate.known);
      if (block) return no(block);
    }

    // The operator's kill-switch is absolute: a disabled provider is not a
    // candidate no matter what it scores.
    if (!this.deps.providers.isEnabled(m.providerId)) {
      return no('Provider is disabled by the operator');
    }

    // Credentials — for THIS caller, and usable right now. hasAny() would pass
    // a provider whose only key belongs to someone else, selecting a primary
    // that can only fail at execution with an authentication error the caller
    // cannot act on.
    //
    // `reasonFor` answers both questions at once and, crucially, says which one
    // failed: an account that is rate-limited for forty seconds used to be
    // reported as no credential being configured, which sends an operator to
    // add a key they already have.
    if (descriptor.auth !== 'none') {
      const credentialProblem = this.deps.credentials.reasonFor(m.providerId, req.userId ?? null, req.workspaceId ?? null);
      if (credentialProblem) return no(credentialProblem);
    }

    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Phase 2: scoring                                                 */
  /* ---------------------------------------------------------------- */

  private weightsFor(mode: RoutingMode): ModeWeights {
    const base = MODE_WEIGHTS[mode] ?? MODE_WEIGHTS.AUTO;
    if (mode !== 'CUSTOM' || !this.opts.customWeights) return base;
    return { ...base, ...this.opts.customWeights };
  }

  private score(
    m: ModelDescriptor,
    req: AIRequest,
    w: ModeWeights,
    pool: string | null,
    prefs: UserPreferences | null,
  ): RoutingCandidate {
    const view = this.deps.models.view(m.id);
    const descriptor = this.deps.providers.descriptor(m.providerId);
    const health = this.deps.health.get(m.providerId);

    const quality = recommendationScore(view?.scores ?? null, view?.performance ?? null, req.taskType) / 100;

    const latency = view?.performance?.latencyMs ?? null;
    // 500ms is excellent, 25s is poor; unmeasured models sit mid-pack so they
    // get sampled rather than starved.
    const speed = latency == null ? 0.55 : clamp01(1 - (latency - 500) / 24_500);

    const estimate = this.estimateCall(m, req);
    // You only score on price if your price is known. A model whose rates are
    // unpublished scores zero here rather than the 1.0 that "$0" used to earn
    // it: it was winning every cost-sensitive comparison precisely because
    // nothing was known about it, which is the opposite of cheap. A partially
    // published card is in the same position — the part nobody published could
    // be any size, so its floor is not a price.
    const cost = costScore(estimate) ?? 0;

    const free = isFree(m.pricing) ? 1 : 0;
    const local = descriptor?.local ? 1 : 0;

    const preference = this.preferenceScore(m, prefs, pool);
    // Only what the operator named counts as an instruction; a pool's member
    // weight is Meridian's own arrangement, not the user's.
    const preferred = Boolean(
      prefs && (prefs.preferredModels.includes(m.id) || prefs.preferredProviders.includes(m.providerId)),
    );
    // Reliability is "will this call work", and that has two halves: how the
    // provider has been behaving, and how sure we are the model can do what
    // this request needs at all. The second half used to be invisible here —
    // the hard constraints read the flat capability list, so a probe-verified
    // claim and a 0.5-confidence name guess were indistinguishable to the thing
    // that actually picks the model. Folding evidence in means verifying a
    // model improves its position rather than only its documentation.
    const required = requiredCapabilitiesOf(req);
    // The clock matters: a verification is evidence about the model as it was
    // when it ran, and providers move models under stable ids.
    const evidence = capabilityConfidence(m.capabilityClaims, m.capabilities, required, this.now());
    const reliability = clamp01((view?.scores?.stability ?? 0.85) * (1 - health.errorRate) * evidence);

    const factors = {
      quality: quality * w.quality,
      speed: speed * w.speed,
      cost: cost * w.cost,
      free: free * w.free,
      local: local * w.local,
      preference: preference * w.preference,
      reliability: reliability * w.reliability,
    };
    const total = Object.values(factors).reduce((s, v) => s + v, 0);

    return {
      modelId: m.id,
      providerId: m.providerId,
      score: Math.round(total * 10_000) / 10_000,
      factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      estimatedCost: estimate.usd,
      costClass: estimate.klass,
      estimatedLatencyMs: latency,
      free: isFree(m.pricing),
      preferred,
    };
  }

  private preferenceScore(m: ModelDescriptor, prefs: UserPreferences | null, pool: string | null): number {
    let score = 0;
    if (prefs) {
      const modelIdx = prefs.preferredModels.indexOf(m.id);
      if (modelIdx >= 0) score = Math.max(score, 1 - modelIdx * 0.15);
      const provIdx = prefs.preferredProviders.indexOf(m.providerId);
      if (provIdx >= 0) score = Math.max(score, 0.7 - provIdx * 0.1);
    }
    if (pool) score = Math.max(score, this.deps.pools.memberWeight(pool, m.id));
    return clamp01(score);
  }

  /**
   * What this call is expected to cost, and whether that is actually known.
   *
   * Free short-circuits because a free model has a known price of zero and
   * there is nothing to estimate. Everything else goes through `estimateCall`,
   * which reports an unpublished rate as unknown instead of as zero.
   */
  private estimateCall(m: ModelDescriptor, req: AIRequest): CallEstimate {
    if (isFree(m.pricing)) return estimateCall(m.pricing, { promptTokens: 0, completionTokens: 0 });
    if (req.modality === 'image' || req.modality === 'video') {
      return estimateCall(m.pricing, { promptTokens: 0, completionTokens: 0, requests: 1 });
    }
    const promptTokens = estimatePromptTokens(req);
    // Assume a response roughly a third the length of the prompt, floored so a
    // one-line prompt still budgets for a real answer.
    const completionTokens = Math.max(256, Math.round(promptTokens / 3));
    return estimateCall(m.pricing, { promptTokens, completionTokens });
  }

  private credentialFor(m: ModelDescriptor, req: AIRequest): { credentialId: string | null; reason: string } {
    const descriptor = this.deps.providers.descriptor(m.providerId);
    const res = this.deps.credentials.resolve(
      { providerId: m.providerId, userId: req.userId, workspaceId: req.workspaceId },
      (descriptor?.auth ?? 'api-key') !== 'none',
      // Routing chooses; execution uses. Only the executor's resolution should
      // advance rotation or last-used marks — this one may describe a call that
      // a budget, a preview, or a failover never lets happen.
      { commit: false },
    );
    return { credentialId: res.credential?.id ?? null, reason: res.reason };
  }

  /* ---------------------------------------------------------------- */
  /* Fallback chain                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Build the alternates tried on failure.
   *
   * Diversity matters more than raw rank: if the first choice fails because its
   * provider is rate limited, the second-best model on the same provider will
   * fail identically. So the chain takes the best remaining candidate from each
   * distinct provider first, and only then fills with same-provider alternates.
   */
  private buildFallbackChain(
    scored: RoutingCandidate[],
    req: AIRequest,
    winner: RoutingCandidate,
  ): RoutingDecision['fallbackChain'] {
    const rest = scored.filter((c) => c.modelId !== winner.modelId);
    const seenProviders = new Set([winner.providerId]);
    const chain: RoutingCandidate[] = [];

    for (const c of rest) {
      if (chain.length >= this.opts.fallbackDepth) break;
      if (seenProviders.has(c.providerId)) continue;
      seenProviders.add(c.providerId);
      chain.push(c);
    }
    for (const c of rest) {
      if (chain.length >= this.opts.fallbackDepth) break;
      if (chain.includes(c)) continue;
      chain.push(c);
    }

    return chain.map((c) => {
      const model = this.deps.models.get(c.modelId)!;
      return {
        provider: c.providerId,
        model: model.providerModelId,
        credential: this.credentialFor(model, req).credentialId,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Explanation                                                      */
  /* ---------------------------------------------------------------- */

  private explain(
    winner: RoutingCandidate,
    model: ModelDescriptor,
    scored: RoutingCandidate[],
    rejected: Rejection[],
    mode: RoutingMode,
    requestedMode: RoutingMode,
    credentialReason: string,
    req: AIRequest,
  ): RoutingReason {
    const view = this.deps.models.view(model.id);
    const health = this.deps.health.get(model.providerId);
    const descriptor = this.deps.providers.descriptor(model.providerId);
    const runnerUp = scored[1];

    const criteria: RoutingReason['criteria'] = [
      {
        label: 'Highest ranked for this task',
        met: true,
        detail: runnerUp
          ? `Scored ${winner.score.toFixed(3)} against ${runnerUp.score.toFixed(3)} for the next best`
          : 'The only candidate that met every requirement',
      },
      {
        label: 'Provider is healthy',
        met: health.circuit === 'closed' && health.state !== 'offline',
        detail: `${health.state}, ${Math.round(health.errorRate * 100)}% recent error rate`,
      },
      {
        label: winner.free
          ? 'Free capacity available'
          : winner.costClass === 'UNKNOWN_COST'
            ? 'Paid routing permitted, but the price is unknown'
            : 'Paid routing explicitly permitted',
        met: true,
        detail: winner.free
          ? `Pricing: ${model.pricing.kind}`
          : winner.costClass === 'UNKNOWN_COST'
            ? `${model.pricing.kind}, and this provider publishes no rate — the cost of this call cannot be predicted`
            : `Estimated $${(winner.estimatedCost ?? 0).toFixed(4)}`,
      },
      {
        label: 'Meets the required context length',
        met: req.contextLength == null || (model.contextLength ?? 0) >= req.contextLength,
        detail: model.contextLength ? `${formatContext(model.contextLength)} context` : 'Context window not published',
      },
    ];

    if (req.toolsRequired || model.capabilities.includes('tools')) {
      criteria.push({
        label: 'Supports tool calling',
        met: model.capabilities.includes('tools'),
        detail: model.capabilities.includes('tools') ? undefined : 'Tools were not required for this request',
      });
    }
    criteria.push({
      label: 'Credential resolved',
      met: true,
      detail: credentialReason,
    });
    if (view?.performance?.latencyMs != null) {
      criteria.push({
        label: 'Low measured latency',
        met: view.performance.latencyMs < 5000,
        detail: `${(view.performance.latencyMs / 1000).toFixed(1)}s mean over ${view.performance.samples} calls`,
      });
    }
    if (descriptor) {
      criteria.push({
        label: 'Provider trust level permitted',
        met: true,
        detail: `${descriptor.trust}${descriptor.local ? ', running locally' : ''}`,
      });
    }

    const qualityNote = view?.scores?.samples ? `measured over ${view.scores.samples} calls` : 'not yet measured';
    const priceNote = winner.free
      ? ' with free capacity'
      : winner.estimatedCost == null
        ? ', at an unpublished price'
        : ` at about $${winner.estimatedCost.toFixed(4)}`;
    const summary = `${model.displayName} on ${descriptor?.name ?? model.providerId}: best ${req.taskType} score (${qualityNote})${priceNote}.`;

    return {
      summary,
      criteria,
      considered: scored.slice(0, 6),
      // Cap the rejection list: a large registry can reject hundreds, and the
      // panel only needs enough to be convincing.
      rejected: dedupeRejections(rejected).slice(0, 12),
      mode,
      requestedMode,
    };
  }

  private explainEmpty(req: AIRequest, mode: RoutingMode, privacy: PrivacyMode, rejected: Rejection[]): string {
    const counts = new Map<string, number>();
    for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const detail = top.length
      ? ` Most common reasons: ${top.map(([reason, n]) => `${reason} (${n})`).join('; ')}.`
      : ' No models are registered yet — connect a provider first.';
    return `No model can serve a ${req.modality}/${req.taskType} request under mode ${mode} and privacy ${privacy}.${detail}`;
  }

  /** Dry-run: the full ranking without committing to a decision. */
  preview(req: AIRequest): { candidates: RoutingCandidate[]; rejected: Rejection[] } {
    const prefs = this.deps.preferencesFor?.(req.userId) ?? null;
    const mode = canonicalMode(req.mode ?? prefs?.routingMode ?? 'AUTO');
    // The dry run must run under the same policy as the real call, or the cost
    // and ranking it shows are for a decision route() would never make.
    const effectiveMode = req.pool ? this.deps.pools.strategyOf(req.pool, mode) : mode;
    const privacy = req.privacyMode ?? prefs?.privacyMode ?? 'TRUSTED_ONLY';
    const rejected: Rejection[] = [];
    const eligible = this.universe(req, req.pool ?? null, rejected).filter(
      (m) =>
        this.passesHardConstraints(m, req, mode, privacy, prefs, rejected) &&
        (effectiveMode === mode || this.passesHardConstraints(m, req, effectiveMode, privacy, prefs, rejected)),
    );
    const weights = this.weightsFor(effectiveMode);
    return {
      candidates: eligible.map((m) => this.score(m, req, weights, req.pool ?? null, prefs)).sort((a, b) => b.score - a.score),
      rejected: dedupeRejections(rejected),
    };
  }
}

/**
 * Every capability this request needs, from all the ways it can ask for one.
 *
 * The named flags and the `requiredCapabilities` list are two spellings of the
 * same thing, and a request may use either.
 */
function requiredCapabilitiesOf(req: AIRequest): Capability[] {
  const out = new Set<Capability>(req.requiredCapabilities ?? []);
  const need = REQUIRED_FOR_MODALITY[req.modality];
  if (need) out.add(need);
  if (req.toolsRequired) out.add('tools');
  if (req.reasoningRequired) out.add('reasoning');
  if (req.visionRequired) out.add('vision');
  return [...out];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function dedupeRejections(rejected: Rejection[]): Rejection[] {
  const seen = new Set<string>();
  return rejected.filter((r) => {
    const key = `${r.modelId}|${r.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * The part of a routing decision worth writing down.
 *
 * A `RoutingReason` is built for the caller's explanation panel and is sized
 * for it: the considered list can run to dozens of candidates and the rejection
 * list into the hundreds, on every single attempt. Storing all of that on every
 * usage row would trade a large table for detail nobody reads.
 *
 * What a person asks afterwards is narrower — which policy applied, what won,
 * what nearly won, and what ruled the rest out — so the runners-up are capped
 * and the rejections are collapsed to reason-with-a-count. The count is the
 * part that carries information: "47 candidates lacked a credential" is a
 * different problem from "47 candidates were too expensive", and neither is
 * legible as 47 individual lines.
 */
export function routingSnapshot(reason: RoutingReason, keepConsidered = 5): RoutingSnapshot {
  const counts = new Map<string, number>();
  for (const r of reason.rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return {
    mode: reason.mode,
    requestedMode: reason.requestedMode,
    summary: reason.summary,
    considered: reason.considered.slice(0, keepConsidered).map((c) => ({
      modelId: c.modelId,
      score: c.score,
      estimatedCost: c.estimatedCost,
      costClass: c.costClass,
    })),
    rejected: [...counts.entries()]
      .map(([r, count]) => ({ reason: r, count }))
      .sort((a, b) => b.count - a.count),
  };
}
