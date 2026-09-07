import type { Capability, ModelDescriptor } from '@meridian/shared';
import type { BackendInfo, GroundingMode, SessionConfig } from './types.js';

/**
 * Choosing a model and a backend, explainably.
 *
 * "Auto" has to mean something. Picking the first available model would be
 * indistinguishable from a bug the first time it chose a text-only model for a
 * screen-reading task, so this scores candidates on the properties that
 * actually decide whether the pairing can work, and returns the reasoning
 * alongside the choice.
 *
 * Two rules are absolute rather than scored:
 *  - a model that cannot see cannot drive a screen, so vision is a filter;
 *  - `local_only` never resolves to a cloud model. If nothing local qualifies,
 *    the answer is "nothing qualifies", not a quiet upgrade to the cloud.
 */

export interface RoutingCandidate {
  model: ModelDescriptor;
  /** Whether the model can be called right now. */
  available: boolean;
  local: boolean;
  /** Observed mean latency in ms, when known. */
  latencyMs: number | null;
  /** Rough cost signal; 0 for free/local. */
  costPerMTok: number | null;
}

export interface RoutingInput {
  candidates: RoutingCandidate[];
  backends: BackendInfo[];
  privacyPreference: SessionConfig['privacyPreference'];
  /** An explicit choice pins that half of the decision. */
  requestedModelId?: string | null;
  requestedBackendId?: string | null;
  groundingMode: GroundingMode;
  /** Prefer cheaper models when the user has not said otherwise. */
  costSensitive?: boolean;
}

export interface RoutingDecision {
  modelId: string | null;
  backendId: string | null;
  groundingModelId: string | null;
  /** Human-readable, shown in the UI verbatim. */
  reason: string;
  /** Every checked property, so the choice can be audited. */
  factors: string[];
  fallbackModelIds: string[];
  fallbackBackendIds: string[];
  /** Set when no combination works; the UI shows this instead of a choice. */
  error: string | null;
}

/** Capabilities a model needs before it can drive a screen at all. */
export const COMPUTER_USE_CAPABILITIES: Capability[] = ['vision'];

function supports(model: ModelDescriptor, capability: Capability): boolean {
  const claim = model.capabilityClaims?.[capability];
  if (claim) return claim.state !== 'unsupported' && claim.state !== 'unknown';
  return model.capabilities.includes(capability);
}

/** Does this model have what a computer agent needs? */
export function canDriveComputer(model: ModelDescriptor): { ok: boolean; missing: Capability[] } {
  const missing = COMPUTER_USE_CAPABILITIES.filter((c) => !supports(model, c));
  return { ok: missing.length === 0, missing };
}

interface Scored {
  candidate: RoutingCandidate;
  score: number;
  notes: string[];
}

function scoreModel(candidate: RoutingCandidate, input: RoutingInput): Scored | null {
  const { model } = candidate;
  const { ok, missing } = canDriveComputer(model);
  if (!ok) return null;
  const notes: string[] = [];
  let score = 0;

  // A confirmed capability is worth more than a guess: acting on an inferred
  // "vision" is how an agent ends up staring at a model that cannot see.
  const visionClaim = model.capabilityClaims?.vision;
  if (visionClaim?.state === 'probe_verified' || visionClaim?.state === 'user_confirmed') {
    score += 0.35;
    notes.push('vision is confirmed, not guessed');
  } else if (visionClaim?.state === 'provider_declared') {
    score += 0.28;
    notes.push('vision declared by the provider');
  } else {
    score += 0.12;
    notes.push('vision is inferred from the model name, not confirmed');
  }

  if (supports(model, 'tools')) {
    score += 0.1;
    notes.push('supports tool calling');
  }
  if (supports(model, 'reasoning')) {
    score += 0.1;
    notes.push('supports reasoning');
  }

  if (candidate.available) {
    score += 0.2;
  } else {
    notes.push('not currently available');
  }

  switch (input.privacyPreference) {
    case 'local_only':
      // Filtered before scoring; reaching here means it is local.
      score += 0.15;
      notes.push('runs locally, as required');
      break;
    case 'prefer_local':
      if (candidate.local) {
        score += 0.12;
        notes.push('runs locally');
      }
      break;
    case 'prefer_cloud':
      if (!candidate.local) score += 0.08;
      break;
    case 'balanced':
      break;
  }

  if (model.contextLength && model.contextLength >= 32_000) {
    score += 0.05;
    notes.push('long enough context for a multi-step session');
  }

  if (input.costSensitive) {
    const cost = candidate.costPerMTok;
    if (cost === 0 || candidate.local) {
      score += 0.08;
      notes.push('free to run');
    } else if (cost != null && cost < 5) {
      score += 0.04;
    }
  }

  if (candidate.latencyMs != null && candidate.latencyMs < 3000) {
    score += 0.04;
    notes.push('responds quickly');
  }

  void missing;
  return { candidate, score: Math.min(1, score), notes };
}

export function route(input: RoutingInput): RoutingDecision {
  const factors: string[] = [];

  /* ---- backend ---------------------------------------------------- */

  const usableBackends = input.backends.filter((b) => b.health.available);
  let backend: BackendInfo | null = null;

  if (input.requestedBackendId) {
    const wanted = input.backends.find((b) => b.id === input.requestedBackendId);
    if (!wanted) {
      return emptyDecision(`No backend called "${input.requestedBackendId}" is registered.`);
    }
    if (!wanted.health.available) {
      return emptyDecision(
        `${wanted.name} is not available: ${wanted.health.detail ?? 'unknown reason'}${wanted.health.remediation ? ` — ${wanted.health.remediation}` : ''}`,
      );
    }
    backend = wanted;
    factors.push(`backend pinned to ${wanted.name}`);
  } else {
    // Prefer a real desktop when one is genuinely reachable; otherwise the
    // browser surface, which is the one that works on a headless server.
    backend = usableBackends.find((b) => b.surface === 'desktop') ?? usableBackends.find((b) => b.surface === 'browser') ?? usableBackends[0] ?? null;
    if (backend) factors.push(`chose ${backend.name} (${backend.surface}) as the available surface`);
  }

  if (!backend) {
    const detail = input.backends
      .map((b) => `${b.name}: ${b.health.detail ?? 'unavailable'}`)
      .join('; ');
    return emptyDecision(`No computer-control backend is available. ${detail}`);
  }

  /* ---- model ------------------------------------------------------- */

  let pool = input.candidates;

  if (input.privacyPreference === 'local_only') {
    pool = pool.filter((c) => c.local);
    factors.push('restricted to local models by the privacy preference');
    if (pool.length === 0) {
      return emptyDecision(
        'No compatible local computer-use model is available. Meridian will not fall back to a cloud model because the privacy preference is set to local only.',
      );
    }
  }

  if (input.requestedModelId) {
    const wanted = pool.find((c) => c.model.id === input.requestedModelId);
    if (!wanted) {
      const elsewhere = input.candidates.find((c) => c.model.id === input.requestedModelId);
      if (elsewhere && input.privacyPreference === 'local_only') {
        return emptyDecision(`${input.requestedModelId} is not a local model, and the privacy preference is set to local only.`);
      }
      return emptyDecision(`No model called "${input.requestedModelId}" is available.`);
    }
    const check = canDriveComputer(wanted.model);
    if (!check.ok) {
      return emptyDecision(
        `${wanted.model.displayName} cannot drive a computer: it does not report ${check.missing.join(', ')}. Choose a model with vision, or confirm the capability on the model's page if you know it has it.`,
      );
    }
    factors.push(`model pinned to ${wanted.model.displayName}`);
    const grounding = pickGrounding(input, pool, wanted.model.id);
    return {
      modelId: wanted.model.id,
      backendId: backend.id,
      groundingModelId: grounding.modelId,
      reason: `Using ${wanted.model.displayName} on ${backend.name}${grounding.modelId ? ` with ${grounding.label} for grounding` : ''}.`,
      factors: [...factors, ...grounding.factors],
      fallbackModelIds: rankFallbacks(pool, input, wanted.model.id),
      fallbackBackendIds: usableBackends.filter((b) => b.id !== backend!.id).map((b) => b.id),
      error: null,
    };
  }

  const scored = pool
    .map((c) => scoreModel(c, input))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return emptyDecision(
      input.candidates.length === 0
        ? 'No models are available. Connect a provider or start a local server, then run discovery.'
        : 'No available model reports the vision capability a computer agent needs. Confirm vision on a model you know supports it, or connect a vision-capable provider.',
    );
  }

  const best = scored[0];
  const grounding = pickGrounding(input, pool, best.candidate.model.id);

  return {
    modelId: best.candidate.model.id,
    backendId: backend.id,
    groundingModelId: grounding.modelId,
    reason: `Using ${best.candidate.model.displayName} on ${backend.name}${grounding.modelId ? ` with ${grounding.label} for grounding` : ''}.`,
    factors: [...factors, ...best.notes, ...grounding.factors],
    fallbackModelIds: scored.slice(1, 4).map((s) => s.candidate.model.id),
    fallbackBackendIds: usableBackends.filter((b) => b.id !== backend!.id).map((b) => b.id),
    error: null,
  };
}

/**
 * Decide what interprets the screen.
 *
 * Agent-S's separation of a reasoning model from a grounding model is the
 * useful idea here: a large model plans well but localises UI elements poorly,
 * while a small specialised model does the opposite. Meridian keeps both
 * possible and does not pretend a dedicated grounder exists when none is
 * configured.
 */
function pickGrounding(
  input: RoutingInput,
  pool: RoutingCandidate[],
  primaryModelId: string,
): { modelId: string | null; label: string; factors: string[] } {
  if (input.groundingMode === 'primary_model') {
    return { modelId: null, label: '', factors: ['grounding handled by the primary model, as configured'] };
  }

  // A grounding model is one whose name marks it as a UI-localisation model.
  // Nothing else in the registry can be assumed to do the job.
  const grounder = pool.find(
    (c) => c.model.id !== primaryModelId && /ui-?tars|grounding|showui|seeclick|omniparser/i.test(`${c.model.id} ${c.model.displayName}`),
  );

  if (input.groundingMode === 'dedicated_model') {
    if (!grounder) {
      return {
        modelId: null,
        label: '',
        factors: ['a dedicated grounding model was requested but none is configured; the primary model will ground'],
      };
    }
    return { modelId: grounder.model.id, label: grounder.model.displayName, factors: ['using the configured grounding model'] };
  }

  // auto
  return grounder
    ? { modelId: grounder.model.id, label: grounder.model.displayName, factors: ['a grounding model is available and was preferred'] }
    : { modelId: null, label: '', factors: ['no dedicated grounding model is available, so the primary model grounds'] };
}

function rankFallbacks(pool: RoutingCandidate[], input: RoutingInput, exclude: string): string[] {
  return pool
    .filter((c) => c.model.id !== exclude)
    .map((c) => scoreModel(c, input))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.candidate.model.id);
}

function emptyDecision(error: string): RoutingDecision {
  return {
    modelId: null,
    backendId: null,
    groundingModelId: null,
    reason: error,
    factors: [],
    fallbackModelIds: [],
    fallbackBackendIds: [],
    error,
  };
}
