import {
  claimIsPositive,
  type Capability,
  type CapabilityMatch,
  type CapabilityRequirement,
  type CapabilityState,
  type ModelDescriptor,
} from '@meridian/shared';

/**
 * Capability matching and search.
 *
 * The question this answers — "which AI can do X?" — is only worth asking if
 * the answer is honest about how it knows. So a match carries per-capability
 * evidence, and a model whose support for something is merely *inferred*
 * ranks below one whose support was proven, rather than being presented as an
 * equal candidate.
 */

/** How much a claim state contributes to a match score. */
const STATE_WEIGHT: Record<CapabilityState, number> = {
  probe_verified: 1,
  user_confirmed: 0.95,
  provider_declared: 0.8,
  inferred: 0.45,
  unsupported: 0,
  unknown: 0,
};

export interface ModelAvailability {
  /** The model can actually be called right now (credential present, healthy). */
  available: boolean;
  /** Runs on the operator's own hardware. */
  local: boolean;
  /** Why it is unavailable, when it is. */
  detail: string | null;
}

export type AvailabilityLookup = (model: ModelDescriptor) => ModelAvailability;

/** The state Meridian holds for one capability of one model. */
export function capabilityState(model: ModelDescriptor, capability: Capability): { state: CapabilityState; source: string } {
  const claim = model.capabilityClaims?.[capability];
  if (claim) return { state: claim.state, source: claim.source };
  // No claim recorded. The flat list is still authoritative for older catalog
  // entries, but it cannot say where it came from, so it is reported as a
  // provider declaration only when the model actually lists it.
  if (model.capabilities.includes(capability)) return { state: 'provider_declared', source: 'catalog entry' };
  return { state: 'unknown', source: 'no information' };
}

export function modelSupports(model: ModelDescriptor, capability: Capability): boolean {
  const claim = model.capabilityClaims?.[capability];
  if (claim) return claimIsPositive(claim);
  return model.capabilities.includes(capability);
}

/**
 * Score one model against a requirement.
 *
 * A model missing a required capability is returned as ineligible rather than
 * dropped: the UI has to be able to show *why* something the user expected to
 * see is not in the list.
 */
export function matchModel(
  model: ModelDescriptor,
  requirement: CapabilityRequirement,
  availability: ModelAvailability,
): CapabilityMatch {
  const evidence: CapabilityMatch['evidence'] = [];
  const missing: CapabilityMatch['missing'] = [];
  const reasons: string[] = [];
  let capabilityScore = 0;

  for (const capability of requirement.capabilities) {
    const { state, source } = capabilityState(model, capability);
    evidence.push({ capability, state, source });
    if (claimIsPositive({ state, source, confidence: 0, at: 0 })) {
      capabilityScore += STATE_WEIGHT[state];
      if (state === 'inferred') reasons.push(`${capability} is inferred from the model name, not confirmed`);
    } else {
      missing.push({ capability, state });
    }
  }

  let eligible = missing.length === 0;

  if (requirement.modalities?.length) {
    const absent = requirement.modalities.filter((m) => !model.modalities.includes(m));
    if (absent.length) {
      eligible = false;
      reasons.push(`does not handle ${absent.join(', ')}`);
    }
  }

  if (requirement.minContextLength != null) {
    if (model.contextLength == null) {
      reasons.push('context length is unknown, so the minimum could not be checked');
    } else if (model.contextLength < requirement.minContextLength) {
      eligible = false;
      reasons.push(`context ${model.contextLength} is below the required ${requirement.minContextLength}`);
    }
  }

  if (requirement.localOnly && !availability.local) {
    eligible = false;
    reasons.push('not a local model, and the request is local-only');
  }

  if (requirement.availableOnly && !availability.available) {
    eligible = false;
    reasons.push(availability.detail ?? 'not available right now');
  }

  if (requirement.requiresMcp && !modelSupports(model, 'tools')) {
    eligible = false;
    reasons.push('MCP needs tool calling, which this model does not report');
  }

  // A model that missed has to say what it missed on. Without this, an
  // ineligible result is an unexplained absence, which is the thing the UI
  // promises never to show.
  for (const miss of missing) {
    reasons.push(
      miss.state === 'unsupported'
        ? `${miss.capability} is recorded as unsupported`
        : `${miss.capability} is not reported for this model`,
    );
  }

  const capabilityAverage = requirement.capabilities.length ? capabilityScore / requirement.capabilities.length : 1;
  // Availability and locality nudge the ranking; they never manufacture
  // eligibility, which is decided entirely above.
  const score = Math.max(
    0,
    Math.min(1, capabilityAverage * 0.8 + (availability.available ? 0.15 : 0) + (availability.local && requirement.localOnly ? 0.05 : 0)),
  );

  if (eligible && reasons.length === 0) reasons.push('satisfies every requested capability');

  return {
    modelId: model.id,
    providerId: model.providerId,
    displayName: model.displayName,
    score,
    evidence,
    missing,
    reasons,
    eligible,
  };
}

/** Rank every model against a requirement, best first. Ineligible ones last. */
export function searchCapabilities(
  models: ModelDescriptor[],
  requirement: CapabilityRequirement,
  availabilityOf: AvailabilityLookup,
): CapabilityMatch[] {
  return models
    .map((m) => matchModel(m, requirement, availabilityOf(m)))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.score - a.score;
    });
}

/**
 * Turn a plain-language question into a capability requirement.
 *
 * Keyword matching, not model inference: it runs locally, instantly, and for
 * free, and the UI shows which requirements it derived so a wrong reading is
 * visible and correctable rather than mysterious.
 */
export function parseRequirement(query: string): CapabilityRequirement {
  const q = query.toLowerCase();
  const capabilities = new Set<Capability>();

  // People write "tools", "images", "analyzing" — a bare \b after each stem
  // would miss every plural and gerund, which is most real phrasing. Each stem
  // therefore tolerates the common inflections and nothing else, so "plan"
  // still does not match "planet".
  const stems = (...words: string[]): RegExp => new RegExp(`\\b(?:${words.join('|')})(?:s|es|ed|ing)?\\b`);

  const rules: { test: RegExp; capability: Capability }[] = [
    { test: stems('image', 'picture', 'photo', 'screenshot', 'vision', 'visual', 'diagram', 'chart', 'see', 'look at'), capability: 'vision' },
    { test: stems('tool', 'function call', 'mcp', 'agent', 'automation'), capability: 'tools' },
    { test: /\b(?:reason|think|plan|complex|math|proof|analy[sz])(?:s|es|ed|ing|ing)?\b/, capability: 'reasoning' },
    { test: stems('json', 'structured', 'schema'), capability: 'structured-output' },
    { test: stems('stream'), capability: 'streaming' },
    { test: stems('embed', 'embedding', 'similarity', 'vector', 'semantic search'), capability: 'embedding' },
    { test: /\b(?:generate|draw|create)\w*\b.{0,20}\b(?:image|picture|art)(?:s)?\b/, capability: 'image-generation' },
    { test: stems('video'), capability: 'video-generation' },
    { test: stems('speak', 'speech', 'voice', 'tts', 'narrate'), capability: 'speech-synthesis' },
    { test: /\b(?:transcri\w*|whisper|audio to text)\b/, capability: 'transcription' },
    { test: /\b(?:long context|large context|whole (?:repo|codebase|book))\b/, capability: 'long-context' },
  ];
  for (const rule of rules) if (rule.test.test(q)) capabilities.add(rule.capability);

  // Browsing is not a model capability; it is tool use plus Meridian's browser.
  if (stems('browse', 'web', 'internet', 'website', 'scrape', 'research').test(q)) capabilities.add('tools');

  const localOnly = /\b(local|offline|on my machine|private|self-hosted)\b/.test(q);
  const requiresMcp = /\bmcp\b/.test(q);

  const contextMatch = /(\d+)\s*k\b/.exec(q);
  const minContextLength = contextMatch ? Number(contextMatch[1]) * 1000 : undefined;

  return {
    // An empty requirement would match everything and mean nothing; text is
    // the floor every usable model clears.
    capabilities: capabilities.size ? [...capabilities] : ['text'],
    localOnly: localOnly || undefined,
    requiresMcp: requiresMcp || undefined,
    minContextLength,
    availableOnly: true,
  };
}
