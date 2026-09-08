import type { Capability, Modality } from './types.js';

/**
 * The control plane's vocabulary: what Meridian knows about a model's
 * abilities and how confident it is, which skills and MCP servers an AI is
 * given, and how those assignments resolve.
 *
 * The organising principle is that a claim must carry its evidence. "This
 * model can see images" is only useful next to how we know — the provider said
 * so, we proved it with a probe, or we guessed from the name. Routing and the
 * UI both read that distinction, and neither is allowed to invent it.
 */

/* ------------------------------------------------------------------ */
/* Capability provenance                                              */
/* ------------------------------------------------------------------ */

/**
 * How a capability claim was established, strongest evidence first.
 *
 *  - `probe_verified`: Meridian sent a real request and the model did it.
 *  - `user_confirmed`: an operator asserted it deliberately.
 *  - `provider_declared`: the provider's own listing said so.
 *  - `inferred`: derived from the model's name or family. A guess, labelled.
 *  - `unsupported`: established as NOT supported — a probe was refused, or an
 *    operator tested it and said so. A *tested negative*, not weak evidence:
 *    see `STATE_RANK` below, where it ranks accordingly.
 *  - `unknown`: nobody has said anything. Never rendered as "no".
 *
 * The array's order is the reading order of that list, which is nearly but not
 * exactly the evidence ranking — `STATE_RANK` is the authority on precedence.
 */
export const CAPABILITY_STATES = [
  'probe_verified',
  'user_confirmed',
  'provider_declared',
  'inferred',
  'unsupported',
  'unknown',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/**
 * Evidence ranking; a stronger claim always wins over a weaker one.
 *
 * The ordering is by **how good the evidence is**, not by what it concludes.
 * That distinction is the whole point, and getting it wrong had teeth:
 * `unsupported` used to sit at the bottom, one below `inferred`, so a guess
 * from a model's name outranked a tested finding that the capability is
 * absent. An operator who marked vision unsupported on a model called
 * `gpt-4o` had that overturned by the name heuristic on the next discovery
 * pass — the weakest evidence in the system beating the strongest, and in the
 * direction that makes the router choose a model the request will fail on.
 *
 * `unsupported` is only ever written deliberately: an operator's explicit
 * judgement, or a probe that got a definitive refusal. It is a *tested
 * negative*, so it ranks with `user_confirmed` — above a provider's optimistic
 * listing and far above a name match. It sits below `probe_verified` because a
 * live call that actually succeeded is better evidence than an earlier "no",
 * and level with `user_confirmed` so an operator can change their mind and
 * have the newer statement win.
 */
const STATE_RANK: Record<CapabilityState, number> = {
  probe_verified: 5,
  user_confirmed: 4,
  unsupported: 4,
  provider_declared: 3,
  inferred: 2,
  unknown: 0,
};

export interface CapabilityClaim {
  state: CapabilityState;
  /** Where it came from, in words: "openai /v1/models", "name heuristic". */
  source: string;
  /** 0..1. Heuristics are honest about being guesses. */
  confidence: number;
  at: number;
}

export type CapabilityClaims = Partial<Record<Capability, CapabilityClaim>>;

/** True when this claim means "yes, it can" rather than "no" or "no idea". */
export function claimIsPositive(claim: CapabilityClaim | undefined): boolean {
  if (!claim) return false;
  return claim.state !== 'unsupported' && claim.state !== 'unknown';
}

/**
 * Merge a new claim into an existing one.
 *
 * Stronger evidence wins. Equal evidence takes the newer observation, which is
 * what makes a re-probe able to correct itself when a provider changes a model
 * underneath a stable id.
 */
export function mergeClaim(existing: CapabilityClaim | undefined, next: CapabilityClaim): CapabilityClaim {
  if (!existing) return next;
  if (STATE_RANK[next.state] > STATE_RANK[existing.state]) return next;
  if (STATE_RANK[next.state] === STATE_RANK[existing.state] && next.at >= existing.at) return next;
  return existing;
}

/**
 * How much to trust that a capability really is there, in [0,1].
 *
 * Used by routing, where the question is not "does the catalogue say this model
 * has vision" but "if I send it an image, will that work". A capability known
 * only from a name match is a coin flip that fails at the provider; one a live
 * probe confirmed is as close to certain as this system gets.
 *
 * Deliberately a *nudge*, not a gate. The floor is 0.7 rather than something
 * punitive because a guess is still usually right, and refusing to route on one
 * would leave a freshly discovered model unroutable until someone probed it —
 * which is how a system ends up never using anything new. Verification earns a
 * better position rather than being the price of entry.
 */
const STATE_CONFIDENCE: Record<CapabilityState, number> = {
  probe_verified: 1,
  user_confirmed: 0.95,
  provider_declared: 0.85,
  inferred: 0.7,
  // Neither of these should reach a scoring path — a model missing a required
  // capability is dropped by the hard constraints first — but if one does, it
  // must not score as though the capability were established.
  unsupported: 0,
  unknown: 0,
};

/**
 * Confidence that a model really has every capability named.
 *
 * The weakest link decides: a model with a probe-verified `tools` and a guessed
 * `vision` is, for a request needing both, only as trustworthy as the guess.
 */
export function capabilityConfidence(
  claims: CapabilityClaims | undefined,
  declared: readonly Capability[],
  required: readonly Capability[],
): number {
  if (!required.length) return 1;
  let weakest = 1;
  for (const cap of required) {
    const claim = claims?.[cap];
    // No claim at all, but the model's own listing includes it: that is a
    // provider declaration that predates the evidence system, and is treated as
    // one rather than as an unknown.
    const confidence = claim ? STATE_CONFIDENCE[claim.state] : declared.includes(cap) ? STATE_CONFIDENCE.provider_declared : 0;
    if (confidence < weakest) weakest = confidence;
  }
  return weakest;
}

export function mergeClaims(existing: CapabilityClaims, next: CapabilityClaims): CapabilityClaims {
  const out: CapabilityClaims = { ...existing };
  for (const [cap, claim] of Object.entries(next) as [Capability, CapabilityClaim][]) {
    out[cap] = mergeClaim(out[cap], claim);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Skills                                                             */
/* ------------------------------------------------------------------ */

/**
 * A reusable instruction document an AI can be given.
 *
 * Skills are content, not code: they are injected into the system context of a
 * request when the resolution engine decides they apply. That is why the token
 * estimate matters — twelve enabled skills can quietly eat a context window,
 * and the UI has to be able to say so before a request fails.
 */
export interface Skill {
  id: string;
  /** Stable, human-typed identifier used in assignments: `code-review`. */
  slug: string;
  name: string;
  description: string;
  /** The instruction text handed to the model. */
  content: string;
  tags: string[];
  /** Capabilities a model must have for this skill to be meaningful. */
  requiresCapabilities: Capability[];
  /** Rough token cost of `content`, computed on save. */
  estimatedTokens: number;
  enabled: boolean;
  version: number;
  source: 'builtin' | 'user' | 'imported';
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Assignment scopes                                                  */
/* ------------------------------------------------------------------ */

/**
 * Where an assignment was made, least specific first.
 *
 * Resolution walks this order and the most specific decision wins, so a global
 * "on" can be turned off for one model without editing the global rule. This
 * ordering is the contract the UI explains to the user.
 */
export const ASSIGNMENT_SCOPES = ['global', 'provider', 'model', 'profile', 'workspace', 'session'] as const;
export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

export const SCOPE_ORDER: AssignmentScope[] = ['global', 'provider', 'model', 'profile', 'workspace', 'session'];

/** What kind of thing is being assigned. */
export type AssignmentKind = 'skill' | 'mcp';

/**
 * One assignment decision.
 *
 * `mode` is deliberately three-valued: an explicit `exclude` is not the same
 * as the absence of an assignment. Excluding a globally-enabled skill for one
 * model is the headline requirement, and it needs a way to say "no" that
 * outranks an inherited "yes".
 */
export interface Assignment {
  id: string;
  kind: AssignmentKind;
  /** Skill slug or MCP server id. */
  targetId: string;
  scope: AssignmentScope;
  /** null for global; otherwise the provider id, model id, profile id, … */
  scopeId: string | null;
  mode: 'include' | 'exclude';
  createdAt: number;
  updatedAt: number;
}

/** Why a resolved item ended up enabled or disabled — shown verbatim in the UI. */
export interface ResolutionReason {
  targetId: string;
  enabled: boolean;
  /** The scope whose decision won. */
  decidedBy: AssignmentScope | 'default';
  scopeId: string | null;
  mode: 'include' | 'exclude' | 'none';
  /** Every scope that had an opinion, in precedence order. */
  considered: { scope: AssignmentScope; scopeId: string | null; mode: 'include' | 'exclude' }[];
  /** Set when the item is enabled by assignment but cannot actually be used. */
  blocked: string | null;
}

/* ------------------------------------------------------------------ */
/* AI profiles                                                        */
/* ------------------------------------------------------------------ */

/**
 * A named, reusable AI configuration.
 *
 * A profile is a saved answer to "which model, with which skills, MCPs and
 * limits". It is the unit the UI assigns things to and the unit a request can
 * name, which is what keeps model choice and capability grants independent —
 * the same skill set can be pointed at a different model without re-authoring.
 */
export interface AIProfile {
  id: string;
  name: string;
  description: string;
  /** Model id, or null to let the router choose within the profile's limits. */
  modelId: string | null;
  /** Pin to a provider without pinning a model. */
  providerId: string | null;
  /** Routing preference applied to requests made under this profile. */
  routingMode: string | null;
  /** Hard requirement: the resolved model must have all of these. */
  requiredCapabilities: Capability[];
  /** Local-only, prefer-local, balanced, prefer-cloud. */
  privacyPreference: PrivacyPreference;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const PRIVACY_PREFERENCES = ['local_only', 'prefer_local', 'balanced', 'prefer_cloud'] as const;
export type PrivacyPreference = (typeof PRIVACY_PREFERENCES)[number];

/* ------------------------------------------------------------------ */
/* Effective configuration                                            */
/* ------------------------------------------------------------------ */

/**
 * Exactly what an AI will be given at runtime, and why.
 *
 * This is the debugging surface for the whole precedence system: if a user
 * cannot explain why a skill is active, the feature has failed regardless of
 * how correct the resolution is.
 */
export interface EffectiveConfig {
  profileId: string | null;
  modelId: string | null;
  providerId: string | null;
  skills: { skill: Skill; reason: ResolutionReason }[];
  excludedSkills: ResolutionReason[];
  mcpServers: { serverId: string; name: string; reason: ResolutionReason }[];
  excludedMcpServers: ResolutionReason[];
  /** Sum of the enabled skills' token estimates. */
  skillTokens: number;
  contextLength: number | null;
  /** skillTokens / contextLength, when both are known. */
  contextPressure: number | null;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Capability search                                                  */
/* ------------------------------------------------------------------ */

export interface CapabilityRequirement {
  capabilities: Capability[];
  modalities?: Modality[];
  minContextLength?: number;
  localOnly?: boolean;
  /** Require the model to be usable right now (credentialed, healthy). */
  availableOnly?: boolean;
  /** Require the model's provider to expose MCP-capable tool calling. */
  requiresMcp?: boolean;
}

export interface CapabilityMatch {
  modelId: string;
  providerId: string;
  displayName: string;
  score: number;
  /** Per-capability evidence for the requested capabilities. */
  evidence: { capability: Capability; state: CapabilityState; source: string }[];
  /** Empty when the model satisfies the requirement. */
  missing: { capability: Capability; state: CapabilityState }[];
  reasons: string[];
  eligible: boolean;
}

/* ------------------------------------------------------------------ */
/* Model change history                                               */
/* ------------------------------------------------------------------ */

export interface ModelChange {
  id: string;
  modelId: string;
  at: number;
  kind: 'discovered' | 'updated' | 'removed';
  /** Field-level differences, e.g. contextLength 128000 -> 256000. */
  changes: { field: string; from: string | null; to: string | null }[];
}

/* ------------------------------------------------------------------ */
/* Connections                                                        */
/* ------------------------------------------------------------------ */

/**
 * How a provider connection was established.
 *
 * `api_key` and `oauth` are kept distinct on purpose: an API key is billed
 * usage, an OAuth/account connection is a subscription. Presenting one as the
 * other would misrepresent what the user is paying for, so the UI reads this
 * field rather than guessing.
 */
export const CONNECTION_METHODS = ['api_key', 'oauth', 'local', 'none'] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export interface ProviderConnection {
  providerId: string;
  name: string;
  connected: boolean;
  method: ConnectionMethod;
  /** Where the credential came from: environment, stored, discovered. */
  credentialSource: string | null;
  /** Never the secret: a non-reversible hint like "sk-…4f2a". */
  hint: string | null;
  models: number;
  health: string;
  lastVerifiedAt: number | null;
  /** What this connection actually grants, in plain words. */
  grants: string;
  detail: string | null;
}
