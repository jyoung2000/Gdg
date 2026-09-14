/**
 * Running capability probes and writing down what they found.
 *
 * The probes themselves live in `@meridian/provider-sdk`; this is the part that
 * knows about credentials, the registry and the database — which model to ask,
 * whose key to use, and how to record an answer so it survives a restart.
 *
 * Two rules shape everything here:
 *
 * - **A probe spends real money and real quota.** So it runs only when asked,
 *   never on a timer; it runs models one at a time; a caller can bound a run by
 *   count before it starts; it refuses outright to touch a model that can
 *   charge unless paid spend is permitted; it stops at a dollar ceiling; and
 *   every probe it does make is written to the usage ledger like any other
 *   call. Spend that does not appear in Activity is spend nobody can see.
 * - **A run that learns nothing must record nothing.** An inconclusive probe
 *   produces no claim, so a provider having a bad minute leaves the registry
 *   exactly as it found it rather than filling it with false negatives. It
 *   still records its *usage*, because an inconclusive probe costs exactly as
 *   much as a conclusive one.
 */
import {
  MeridianError,
  computeCost,
  mayCharge,
  mergeClaims,
  newId,
  timeoutSignal,
  type Capability,
  type Logger,
  type ModelDescriptor,
  type UsageRecord,
} from '@meridian/shared';
import { probeModel, probeableCapabilities, type ModelProbeReport } from '@meridian/provider-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import type { ProviderAdapter, ProviderRegistry } from '@meridian/provider-sdk';
import type { CredentialResolver } from '@meridian/routing-sdk';
import type { Store } from '../db/store.js';

export interface VerificationDeps {
  providers: ProviderRegistry;
  models: ModelRegistry;
  credentials: CredentialResolver;
  store: Store;
  logger: Logger;
  /**
   * Whether this deployment is permitted to spend money at all.
   *
   * The same switch the router obeys. A probe is an ordinary paid call wearing
   * a diagnostic hat, and a deployment that has said "free models only" did not
   * carve out an exception for diagnostics.
   */
  allowPaid: () => boolean;
  /**
   * Where a probe's spend is written down.
   *
   * Optional only so the service can be constructed in isolation; wired in the
   * app it is the same sink every completion uses, which is what puts probe
   * spend in Activity, in the cost totals and in front of the person paying.
   */
  recordUsage?: (row: UsageRecord) => void;
}

export interface VerifyRequest {
  /** Probe these models. Defaults to every model of the given provider. */
  modelIds?: string[];
  providerId?: string;
  capabilities?: Capability[];
  /** Hard ceiling on how many models one run may touch. */
  limit?: number;
  /**
   * Permit probing models that can charge, for this run only.
   *
   * Defaults to the deployment setting. Passing `true` is the explicit
   * permission that spending someone's money requires; it does not remove the
   * dollar ceiling below, which still binds.
   */
  allowPaid?: boolean;
  /**
   * Most this run may spend, in USD. Defaults to {@link DEFAULT_MAX_COST_USD}.
   *
   * Permission without a ceiling is how a diagnostic becomes a bill: 300 models
   * × a handful of probes each is a number nobody intends. The run stops when
   * the next model's worst case would cross this, and says so.
   */
  maxCostUsd?: number;
  /** Who the spend belongs to, for the usage ledger. */
  userId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VerifyReport {
  probed: number;
  /** Models skipped before any request was made, and why. */
  skipped: { modelId: string; reason: string }[];
  reports: ModelProbeReport[];
  /** Capability claims actually written, across all models. */
  claimsWritten: number;
  /** Probes that reached no verdict, so recorded nothing. */
  inconclusive: number;
  /** Individual probe requests made, across all models. */
  probeCalls: number;
  /** USD this run actually spent, from each model's own rate card. */
  cost: number;
  /**
   * False when `cost` is a floor rather than the figure.
   *
   * A provider that reports no token counts on a per-token rate card leaves a
   * probe unpriceable after the fact. Reporting the resulting zero as the cost
   * would be the same untruth as calling an unpublished rate free.
   */
  costKnown: boolean;
  /** The ceiling the run was held to, so a truncated run can explain itself. */
  maxCostUsd: number;
  startedAt: number;
  finishedAt: number;
}

/** Nothing is probed above this in one run without asking for it explicitly. */
const DEFAULT_LIMIT = 25;

/**
 * Default dollar ceiling for one run.
 *
 * Low on purpose. A probe is meant to cost fractions of a cent, so half a
 * dollar is already hundreds of them; a run that reaches this has found
 * something unexpected — a model priced per request, a rate card in the wrong
 * units — and stopping to say so beats spending through it.
 */
const DEFAULT_MAX_COST_USD = 0.5;

/**
 * Worst case tokens charged for a single probe, for the pre-flight estimate.
 *
 * The probes ask for 5 or 64 output tokens, but a model that rejects our
 * optional parameters is re-probed without them — with no ceiling at all. So
 * the estimate assumes that path, generously, rather than the happy one.
 */
const PROBE_RESERVE_PROMPT_TOKENS = 256;
const PROBE_RESERVE_COMPLETION_TOKENS = 512;

/**
 * Can this rate card put a number on a call at all?
 *
 * `isFree` already separates "charges nothing" from "charges something", and
 * deliberately treats a card with no rates at all as *not* free. This is the
 * other half of that distinction: a card that can charge and states no rate
 * cannot be priced, and anything that tries will get zero.
 */
function priceable(pricing: ModelDescriptor['pricing']): boolean {
  return pricing.inputPerMTok != null || pricing.outputPerMTok != null || pricing.perRequest != null;
}

export class VerificationService {
  private readonly deps: VerificationDeps;
  private running = false;

  constructor(deps: VerificationDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * Probe models and persist what was learned.
   *
   * Refuses to run concurrently with itself: two runs would double the spend
   * and race each other's writes for no benefit.
   */
  async verify(req: VerifyRequest = {}): Promise<VerifyReport> {
    if (this.running) throw new MeridianError('invalid_request', 'A verification run is already in progress');
    this.running = true;
    const startedAt = Date.now();
    const skipped: { modelId: string; reason: string }[] = [];
    const reports: ModelProbeReport[] = [];
    let claimsWritten = 0;
    let inconclusive = 0;
    let probeCalls = 0;
    let cost = 0;
    let costKnown = true;

    const allowPaid = req.allowPaid ?? this.deps.allowPaid();
    const maxCostUsd = Math.max(0, req.maxCostUsd ?? DEFAULT_MAX_COST_USD);

    try {
      const targets = this.targets(req, skipped);
      for (const model of targets) {
        if (req.signal?.aborted) {
          skipped.push({ modelId: model.id, reason: 'the run was cancelled' });
          continue;
        }

        const adapter = this.deps.providers.get(model.providerId);
        const descriptor = this.deps.providers.descriptor(model.providerId);
        if (!adapter || !descriptor) {
          skipped.push({ modelId: model.id, reason: 'its provider has no adapter' });
          continue;
        }

        // A probe is a paid call. Everything below this point spends, so the
        // permission and the ceiling are checked before anything is sent —
        // not after, when the money is already gone.
        if (mayCharge(model.pricing) && !allowPaid) {
          skipped.push({
            modelId: model.id,
            reason: 'it can charge money, and this run was not given permission to spend',
          });
          continue;
        }

        const worstCase = this.worstCase(model, adapter, req.capabilities);
        // An unpriceable model is refused rather than waved past. A card that
        // can charge but publishes no rate prices a probe at exactly zero, and
        // a zero cannot be compared to a ceiling — so before this check, a
        // whole catalogue of unpriced metered models passed a $0.50 ceiling
        // unlimited times and reported having spent nothing.
        if (!worstCase.known) {
          skipped.push({
            modelId: model.id,
            reason:
              'it can charge money and publishes no rate, so a probe cannot be shown to fit this run’s ceiling',
          });
          continue;
        }
        if (cost + worstCase.usd > maxCostUsd) {
          skipped.push({
            modelId: model.id,
            reason: `probing it could cost up to $${worstCase.usd.toFixed(4)}, which would pass this run's $${maxCostUsd.toFixed(2)} ceiling`,
          });
          continue;
        }

        // A probe without a credential is not a probe, it is a guaranteed auth
        // error that would be recorded as "learned nothing" for every model on
        // the provider. Skipping says so once instead.
        const resolution = this.deps.credentials.resolve({ providerId: model.providerId }, descriptor.auth !== 'none');
        if (!resolution.credential && descriptor.auth !== 'none') {
          skipped.push({ modelId: model.id, reason: 'no credential is configured for its provider' });
          continue;
        }

        const timeoutMs = req.timeoutMs ?? 30_000;
        const report = await probeModel(
          adapter,
          model,
          {
            secret: resolution.credential?.secret ?? null,
            logger: this.deps.logger.child({ providerId: model.providerId, modelId: model.id }),
            requestId: `probe-${model.id}`,
            timeoutMs,
            signal: req.signal ?? timeoutSignal(timeoutMs * 6),
          },
          { capabilities: req.capabilities, timeoutMs, signal: req.signal },
        );

        reports.push(report);
        inconclusive += report.results.filter((r) => r.outcome === 'inconclusive').length;
        probeCalls += report.results.length;
        const metered = this.meter(model, resolution.credential?.id ?? null, report, req.userId ?? null);
        cost += metered.cost;
        if (!metered.known) costKnown = false;
        claimsWritten += this.record(model, report);
      }

      this.deps.logger.info('verification run complete', {
        probed: reports.length,
        skipped: skipped.length,
        claimsWritten,
        inconclusive,
        probeCalls,
        cost,
        costKnown,
      });

      return {
        probed: reports.length,
        skipped,
        reports,
        claimsWritten,
        inconclusive,
        probeCalls,
        cost: Math.round(cost * 1e5) / 1e5,
        costKnown,
        maxCostUsd,
        startedAt,
        finishedAt: Date.now(),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * The most probing this model could cost, and whether that number means
   * anything.
   *
   * Deliberately an over-estimate: the ceiling exists to stop a surprise, and
   * an optimistic estimate is exactly the thing that lets the surprise through.
   * A free model estimates at zero, which is what keeps the ceiling from
   * refusing free work.
   *
   * `known` is the part that matters. `computeCost` adds a term per published
   * rate, so a METERED card with every rate null prices anything at exactly
   * $0.00 — and `mayCharge` correctly says it can charge. Returning that zero
   * as the estimate let an unpriced model pass any ceiling, any number of
   * times. An unpublished rate is not a rate of zero; it is the absence of one,
   * and it is reported as such so the caller can refuse.
   */
  private worstCase(
    model: ModelDescriptor,
    adapter: ProviderAdapter,
    requested?: Capability[],
  ): { usd: number; known: boolean } {
    const count = requested?.length ?? probeableCapabilities(model, adapter).length;
    if (!count) return { usd: 0, known: true };
    if (!mayCharge(model.pricing)) return { usd: 0, known: true };
    if (!priceable(model.pricing)) return { usd: 0, known: false };
    const each = computeCost(model.pricing, PROBE_RESERVE_PROMPT_TOKENS, PROBE_RESERVE_COMPLETION_TOKENS);
    // The untuned retry doubles the request count in the worst case.
    return { usd: each * count * 2, known: true };
  }

  /**
   * Write each probe down as usage, and return what the model's rate card says
   * it cost.
   *
   * One row per probe, because one probe is one request against one key. An
   * inconclusive probe is recorded too — a 429 or a timeout still consumed the
   * provider's attention and, for a model priced per request, still charged.
   * Recording only the useful ones would make the ledger read as though
   * verification were free whenever it went badly.
   */
  private meter(
    model: ModelDescriptor,
    credentialId: string | null,
    report: ModelProbeReport,
    userId: string | null,
  ): { cost: number; known: boolean } {
    let total = 0;
    let known = true;
    for (const result of report.results) {
      // Tokens the provider actually reported, or nothing. Not a guess: this
      // row is cost accounting, and an invented token count is a fabricated
      // bill. A model that reports no usage produces a zero-token row whose
      // per-request pricing still lands, which is the honest shape.
      const promptTokens = result.promptTokens ?? 0;
      const completionTokens = result.completionTokens ?? 0;
      const spent = computeCost(model.pricing, promptTokens, completionTokens);
      total += spent;
      // A per-token card plus a provider that reported no tokens leaves this
      // probe's real cost unknown. The row still says what can be shown — a
      // per-request rate, if there is one — but the run must not present the
      // total as the figure when part of it is a floor.
      if (mayCharge(model.pricing) && result.promptTokens == null && result.completionTokens == null) {
        if (model.pricing.inputPerMTok != null || model.pricing.outputPerMTok != null) known = false;
      }
      this.deps.recordUsage?.({
        id: newId('use'),
        at: Date.now(),
        requestId: `probe-${model.id}-${result.capability}`,
        userId,
        workspaceId: null,
        taskId: null,
        agentRole: null,
        stepId: null,
        providerId: model.providerId,
        modelId: model.id,
        credentialId,
        poolId: null,
        modality: 'text',
        taskType: 'capability-probe',
        promptTokens,
        completionTokens,
        cost: spent,
        latencyMs: result.latencyMs,
        ttftMs: null,
        // "Did the request complete", not "did the model pass". An
        // `unsupported` verdict is a probe that worked perfectly.
        success: result.outcome !== 'inconclusive',
        fallbackCount: 0,
        errorCode: result.outcome === 'inconclusive' ? 'probe_inconclusive' : null,
        routing: null,
        contextTokensSaved: null,
      });
    }
    return { cost: total, known };
  }

  /**
   * Fold a probe report into the model and persist it.
   *
   * The claims merge rather than replace, so a probe that reached no verdict on
   * vision leaves an operator's earlier finding about vision alone. The flat
   * capability list is then rebuilt from the merged evidence — which is how a
   * probed `unsupported` actually removes a capability instead of leaving a
   * contradiction between the list and the claim beside it.
   */
  private record(model: ModelDescriptor, report: ModelProbeReport): number {
    const claimed = Object.keys(report.claims) as Capability[];
    if (!claimed.length) return 0;

    const merged = mergeClaims(model.capabilityClaims ?? {}, report.claims);
    const capabilities = new Set(model.capabilities);
    for (const capability of claimed) {
      if (merged[capability]?.state === 'unsupported') capabilities.delete(capability);
      else if (merged[capability]?.state === 'probe_verified') capabilities.add(capability);
    }

    const next: ModelDescriptor = {
      ...model,
      capabilities: [...capabilities],
      capabilityClaims: merged,
      lastVerifiedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.deps.models.upsert(next);
    this.deps.store.upsertModels([next]);
    return claimed.length;
  }

  /** Which models this run will touch, with everything excluded explained. */
  private targets(req: VerifyRequest, skipped: { modelId: string; reason: string }[]): ModelDescriptor[] {
    let candidates: ModelDescriptor[];
    if (req.modelIds?.length) {
      candidates = [];
      for (const id of req.modelIds) {
        const model = this.deps.models.get(id);
        if (model) candidates.push(model);
        else skipped.push({ modelId: id, reason: 'no such model is registered' });
      }
    } else {
      candidates = this.deps.models.all();
      if (req.providerId) candidates = candidates.filter((m) => m.providerId === req.providerId);
    }

    const limit = Math.max(1, req.limit ?? DEFAULT_LIMIT);
    // Say what the cap dropped. A run that silently probed 25 of 300 models and
    // reported success would read as "everything is verified".
    if (candidates.length > limit) {
      for (const m of candidates.slice(limit)) {
        skipped.push({ modelId: m.id, reason: `beyond this run's limit of ${limit} models` });
      }
      candidates = candidates.slice(0, limit);
    }

    // A model with nothing worth probing is not an error, but it is worth
    // reporting rather than counting as verified.
    return candidates.filter((model) => {
      const adapter = this.deps.providers.get(model.providerId);
      if (!adapter) return true; // handled in the loop, with a clearer reason
      if (req.capabilities?.length) return true;
      if (probeableCapabilities(model, adapter).length > 0) return true;
      skipped.push({ modelId: model.id, reason: 'its adapter exposes nothing this can probe' });
      return false;
    });
  }
}
