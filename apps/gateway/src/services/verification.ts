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
 *   never on a timer; it runs models one at a time; and a caller can bound a
 *   run by count before it starts.
 * - **A run that learns nothing must record nothing.** An inconclusive probe
 *   produces no claim, so a provider having a bad minute leaves the registry
 *   exactly as it found it rather than filling it with false negatives.
 */
import {
  MeridianError,
  mergeClaims,
  timeoutSignal,
  type Capability,
  type Logger,
  type ModelDescriptor,
} from '@meridian/shared';
import { probeModel, probeableCapabilities, type ModelProbeReport } from '@meridian/provider-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import type { ProviderRegistry } from '@meridian/provider-sdk';
import type { CredentialResolver } from '@meridian/routing-sdk';
import type { Store } from '../db/store.js';

export interface VerificationDeps {
  providers: ProviderRegistry;
  models: ModelRegistry;
  credentials: CredentialResolver;
  store: Store;
  logger: Logger;
}

export interface VerifyRequest {
  /** Probe these models. Defaults to every model of the given provider. */
  modelIds?: string[];
  providerId?: string;
  capabilities?: Capability[];
  /** Hard ceiling on how many models one run may touch. */
  limit?: number;
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
  startedAt: number;
  finishedAt: number;
}

/** Nothing is probed above this in one run without asking for it explicitly. */
const DEFAULT_LIMIT = 25;

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
        claimsWritten += this.record(model, report);
      }

      this.deps.logger.info('verification run complete', {
        probed: reports.length,
        skipped: skipped.length,
        claimsWritten,
        inconclusive,
      });

      return {
        probed: reports.length,
        skipped,
        reports,
        claimsWritten,
        inconclusive,
        startedAt,
        finishedAt: Date.now(),
      };
    } finally {
      this.running = false;
    }
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
