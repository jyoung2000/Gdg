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
        if (cost + worstCase > maxCostUsd) {
          skipped.push({
            modelId: model.id,
            reason: `probing it could cost up to $${worstCase.toFixed(4)}, which would pass this run's $${maxCostUsd.toFixed(2)} ceiling`,
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
        cost += this.meter(model, resolution.credential?.id ?? null, report, req.userId ?? null);
        claimsWritten += this.record(model, report);
      }

      this.deps.logger.info('verification run complete', {
        probed: reports.length,
        skipped: skipped.length,
        claimsWritten,
        inconclusive,
        probeCalls,
        cost,
      });

      return {
        probed: reports.length,
        skipped,
        reports,
        claimsWritten,
        inconclusive,
        probeCalls,
        cost: Math.round(cost * 1e5) / 1e5,
        maxCostUsd,
        startedAt,
        finishedAt: Date.now(),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * The most probing this model could cost, before anything is sent.
   *
   * Deliberately an over-estimate: the ceiling exists to stop a surprise, and
   * an optimistic estimate is exactly the thing that lets the surprise through.
   * A free model estimates at zero, which is what keeps the ceiling from
   * refusing free work.
   */
  private worstCase(model: ModelDescriptor, adapter: ProviderAdapter, requested?: Capability[]): number {
    const count = requested?.length ?? probeableCapabilities(model, adapter).length;
    if (!count) return 0;
    const each = computeCost(model.pricing, PROBE_RESERVE_PROMPT_TOKENS, PROBE_RESERVE_COMPLETION_TOKENS);
    // The untuned retry doubles the request count in the worst case.
    return each * count * 2;
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
  ): number {
    let total = 0;
    for (const result of report.results) {
      // Tokens the provider actually reported, or nothing. Not a guess: this
      // row is cost accounting, and an invented token count is a fabricated
      // bill. A model that reports no usage produces a zero-token row whose
      // per-request pricing still lands, which is the honest shape.
      const promptTokens = result.promptTokens ?? 0;
      const completionTokens = result.completionTokens ?? 0;
      const spent = computeCost(model.pricing, promptTokens, completionTokens);
      total += spent;
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
    return total;
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
