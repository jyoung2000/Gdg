import {
  claimIsPositive,
  mergeClaim,
  mergeClaims,
  type Capability,
  type CapabilityClaims,
  type Modality,
  type ModelDescriptor,
} from '@meridian/shared';

/**
 * Capability priors inferred from a model's identifier.
 *
 * These are HINTS, not facts. A provider's own metadata always wins, and a
 * verified capability from a successful live call supersedes both. They exist
 * because most OpenAI-compatible listing endpoints return nothing but an id,
 * and routing to a text-only model for a vision task is a worse outcome than
 * a cautious guess. Everything here is a substring rule over public model
 * naming conventions — no claim is made about any provider's private details.
 */

interface Rule {
  match: RegExp;
  modalities?: Modality[];
  capabilities?: Capability[];
  tags?: string[];
  /** Approximate context window, when the name itself encodes one. */
  contextLength?: number;
}

const RULES: Rule[] = [
  // Vision-capable families, by their published names.
  { match: /llava|bakllava|minicpm-?v|moondream/i, modalities: ['vision'], capabilities: ['vision'], tags: ['vision'] },
  { match: /\bvl\b|-vl-|vision|gpt-4o|gpt-4\.1|gpt-5|claude-(3|4|opus|sonnet|haiku)|gemini-(1\.5|2|3)|pixtral|grok-.*vision/i,
    modalities: ['vision'], capabilities: ['vision'], tags: ['vision'] },

  // Embedding models — these serve a different endpoint entirely.
  { match: /embed|bge-|gte-|e5-|nomic-embed|text-embedding/i, modalities: ['embedding'], capabilities: ['embedding'], tags: ['embedding'] },

  // Coding-specialised families.
  { match: /coder|code-|codestral|codellama|starcoder|deepseek-coder|qwen.*coder|devstral/i, tags: ['coding'] },

  // Reasoning-first families.
  { match: /\bo[1-9]\b|-r1|reasoner|thinking|qwq|deepseek-r|magistral/i, capabilities: ['reasoning'], tags: ['reasoning'] },

  // Image generation families.
  { match: /flux|stable-?diffusion|\bsdxl\b|\bsd3\b|dall-?e|imagen|playground-v|kandinsky|midjourney/i,
    modalities: ['image'], capabilities: ['image-generation'], tags: ['image'] },

  // Video generation families.
  { match: /veo|sora|kling|runway|luma|ltx-?video|hunyuan-?video|wan-?\d|mochi|cogvideo|svd|stable-?video/i,
    modalities: ['video'], capabilities: ['video-generation'], tags: ['video'] },

  // Speech and transcription.
  { match: /whisper|distil-whisper|parakeet|wav2vec/i, modalities: ['transcription'], capabilities: ['transcription'], tags: ['audio'] },
  { match: /\btts\b|xtts|bark|kokoro|piper|speecht5|orpheus/i, modalities: ['speech'], capabilities: ['speech-synthesis'], tags: ['audio'] },
];

/** Context windows encoded in a model id, e.g. "-32k", "-128k", "-1m". */
function contextFromName(id: string): number | null {
  const m = /[-_](\d+)(k|m)\b/i.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2].toLowerCase() === 'm' ? n * 1_000_000 : n * 1024;
}

export interface Inference {
  modalities: Modality[];
  capabilities: Capability[];
  tags: string[];
  contextLength: number | null;
  /** True when at least one rule matched — used to mark the guess as weak. */
  matched: boolean;
}

export function inferFromName(modelId: string): Inference {
  const modalities = new Set<Modality>();
  const capabilities = new Set<Capability>();
  const tags = new Set<string>();
  let matched = false;

  for (const rule of RULES) {
    if (!rule.match.test(modelId)) continue;
    matched = true;
    rule.modalities?.forEach((m) => modalities.add(m));
    rule.capabilities?.forEach((c) => capabilities.add(c));
    rule.tags?.forEach((t) => tags.add(t));
  }

  return {
    modalities: [...modalities],
    capabilities: [...capabilities],
    tags: [...tags],
    contextLength: contextFromName(modelId),
    matched,
  };
}

/**
 * Merge inferred hints into a discovered descriptor without ever overwriting
 * something the provider told us directly.
 */
export function enrich(model: ModelDescriptor, opts: EnrichOptions = {}): ModelDescriptor {
  const hint = inferFromName(model.providerModelId);
  const modalities = [...new Set([...model.modalities, ...hint.modalities])];
  const isMediaOnly =
    hint.modalities.some((m) => m === 'image' || m === 'video' || m === 'speech' || m === 'transcription' || m === 'embedding') &&
    !hint.modalities.includes('vision');

  const at = opts.now ?? Date.now();
  // Two sources meet here and the difference between them is the whole point of
  // provenance: what the provider listed is its own claim, what the name
  // matched is our guess. Merging them into one flat array — as this used to —
  // makes a heuristic indistinguishable from a fact.
  const claims: CapabilityClaims = {};
  const declaredSource = opts.declaredSource ?? (model.discovered ? `${model.providerId} listing` : 'shipped catalog');
  for (const cap of model.capabilities) {
    claims[cap] = { state: 'provider_declared', source: declaredSource, confidence: 0.9, at };
  }
  for (const cap of hint.capabilities) {
    claims[cap] = mergeClaim(claims[cap], { state: 'inferred', source: 'model-name heuristic', confidence: 0.5, at });
  }

  // Anything already established (a probe result, an operator's confirmation)
  // outranks both of the above and survives re-enrichment.
  const merged = mergeClaims(claims, model.capabilityClaims ?? {});

  // The flat list is a *projection of the evidence*, not a second opinion
  // alongside it. It used to be an independent union of the listing and the
  // heuristic, which meant a capability someone had tested and found absent was
  // re-added by a name match on the very next pass — the weakest evidence
  // silently overruling the strongest, in the direction that makes the router
  // pick a model that will fail. Deriving the list from the merged claims makes
  // that structurally impossible: to appear here, a capability must have a
  // winning claim that is not `unsupported`.
  const capabilities = [...new Set([...model.capabilities, ...hint.capabilities])].filter((cap) =>
    claimIsPositive(merged[cap]),
  );

  return {
    ...model,
    // A dedicated image or embedding model is not a text model, even though the
    // generic listing shape defaults everything to text.
    modalities: isMediaOnly ? hint.modalities : modalities,
    capabilities,
    tags: [...new Set([...model.tags, ...hint.tags])],
    contextLength: model.contextLength ?? hint.contextLength,
    capabilityClaims: merged,
    discoveredAt: model.discoveredAt ?? at,
    lastVerifiedAt: model.discovered ? at : model.lastVerifiedAt,
  };
}

export interface EnrichOptions {
  /** Names the provider listing, for the provenance record. */
  declaredSource?: string;
  now?: number;
}
