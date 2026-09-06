import type { DataUsePolicy, Pricing, ProviderDescriptor } from '@meridian/shared';

/**
 * The shipped provider catalog.
 *
 * Two rules govern everything in this file.
 *
 * First, nothing is guessed. Where Meridian does not have authoritative
 * knowledge of a provider's data-use policy, the field is `unknown` and a
 * `policyUrl` points at the provider's own published terms. An operator records
 * what they have actually verified in Settings, and that verified value is what
 * the UI displays from then on. "Unknown" is a real answer here, not a
 * placeholder to be filled in with an optimistic guess.
 *
 * Second, pricing in this file is a *posture*, not a rate card. Published rates
 * change constantly, so the numeric rates are null and live discovery supplies
 * the real ones where a provider publishes them (OpenRouter does). A provider
 * whose free tier is a rate-limited allowance is `FREE_DAILY`, never `FREE` —
 * conflating the two is exactly the mislabelling the product forbids.
 */

/** The honest default: we do not know, and here is where to find out. */
const unverified = (policyUrl: string | null, privacyNote?: string): DataUsePolicy => ({
  trainingUse: 'unknown',
  commercialUse: 'unknown',
  retention: null,
  privacyNote: privacyNote ?? 'Not verified by this instance. Check the provider’s policy and record it in Settings.',
  policyUrl,
});

/** Local inference is the one case where the answer is structural, not a claim. */
const localDataUse: DataUsePolicy = {
  trainingUse: 'not_allowed',
  commercialUse: 'unknown',
  retention: 'Nothing leaves this machine.',
  privacyNote:
    'Runs on your own hardware, so no request data reaches a third party. Commercial use depends on the licence of the individual model you load.',
  policyUrl: null,
};

const METERED: Pricing = { kind: 'METERED', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: 'Rates are read from the provider where it publishes them.' };
const LOCAL: Pricing = { kind: 'LOCAL', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: 'Runs on your own hardware.' };
const FREE: Pricing = { kind: 'FREE', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };
const freeDaily = (note: string): Pricing => ({
  kind: 'FREE_DAILY',
  inputPerMTok: null,
  outputPerMTok: null,
  perRequest: null,
  note,
});

const RATE_LIMITED_FREE_TIER =
  'Free tier is a rate-limited allowance, not unlimited capacity. Limits change — confirm the current ones with the provider.';

export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  /* ---------------- Aggregators ---------------- */
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kinds: ['llm', 'coding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'api-key',
    envKeys: ['OPENROUTER_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://openrouter.ai/docs',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://openrouter.ai/privacy'),
    defaultPricing: METERED,
    notes:
      'Aggregates many upstream providers. Per-model pricing and context lengths are read live from its model listing, and models priced at zero are surfaced as free.',
  },

  /* ---------------- Fast inference ---------------- */
  {
    id: 'groq',
    name: 'Groq',
    kinds: ['llm', 'coding', 'audio'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'api-key',
    envKeys: ['GROQ_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://console.groq.com/docs',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://groq.com/privacy-policy/'),
    defaultPricing: freeDaily(RATE_LIMITED_FREE_TIER),
    notes: 'Very low latency. Also serves Whisper transcription.',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kinds: ['llm', 'coding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    auth: 'api-key',
    envKeys: ['CEREBRAS_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://inference-docs.cerebras.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://www.cerebras.ai/privacy-policy'),
    defaultPricing: freeDaily(RATE_LIMITED_FREE_TIER),
    notes: 'Very high tokens/second on a small model selection.',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    kinds: ['llm', 'coding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.sambanova.ai/v1',
    auth: 'api-key',
    envKeys: ['SAMBANOVA_API_KEY'],
    trust: 'unknown',
    docsUrl: 'https://docs.sambanova.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://sambanova.ai/privacy-policy'),
    defaultPricing: freeDaily(RATE_LIMITED_FREE_TIER),
  },

  /* ---------------- Open-weight hosts ---------------- */
  {
    id: 'together',
    name: 'Together AI',
    kinds: ['llm', 'coding', 'image', 'embedding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    auth: 'api-key',
    envKeys: ['TOGETHER_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://docs.together.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://www.together.ai/privacy'),
    defaultPricing: METERED,
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kinds: ['llm', 'coding', 'image', 'embedding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: 'api-key',
    envKeys: ['FIREWORKS_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://docs.fireworks.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://fireworks.ai/privacy-policy'),
    defaultPricing: METERED,
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    kinds: ['llm', 'coding', 'image'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    auth: 'api-key',
    envKeys: ['HYPERBOLIC_API_KEY'],
    trust: 'unknown',
    docsUrl: 'https://docs.hyperbolic.xyz',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://hyperbolic.xyz/privacy'),
    defaultPricing: METERED,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    kinds: ['llm', 'coding', 'embedding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    auth: 'api-key',
    envKeys: ['NVIDIA_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://docs.api.nvidia.com',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://www.nvidia.com/en-us/about-nvidia/privacy-policy/'),
    defaultPricing: freeDaily('Free evaluation credits, not a permanent free tier.'),
  },

  /* ---------------- First-party model builders ---------------- */
  {
    id: 'anthropic',
    name: 'Anthropic',
    kinds: ['llm', 'coding'],
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: 'api-key',
    envKeys: ['ANTHROPIC_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://docs.anthropic.com',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://www.anthropic.com/legal/privacy'),
    defaultPricing: METERED,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kinds: ['llm', 'coding', 'image', 'audio', 'speech', 'embedding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'api-key',
    envKeys: ['OPENAI_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://platform.openai.com/docs',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://openai.com/policies/privacy-policy/'),
    defaultPricing: METERED,
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    kinds: ['llm', 'coding', 'embedding'],
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'api-key',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified(
      'https://ai.google.dev/gemini-api/terms',
      'Data handling differs between the free and paid tiers of this API. Read the terms for the tier your key is on before sending anything sensitive.',
    ),
    defaultPricing: freeDaily(RATE_LIMITED_FREE_TIER),
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kinds: ['llm', 'coding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    auth: 'api-key',
    envKeys: ['DEEPSEEK_API_KEY'],
    trust: 'unknown',
    docsUrl: 'https://api-docs.deepseek.com',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html'),
    defaultPricing: METERED,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kinds: ['llm', 'coding', 'embedding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'api-key',
    envKeys: ['MISTRAL_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://docs.mistral.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://mistral.ai/terms/#privacy-policy'),
    defaultPricing: METERED,
  },
  {
    id: 'xai',
    name: 'xAI',
    kinds: ['llm', 'coding'],
    adapter: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    auth: 'api-key',
    envKeys: ['XAI_API_KEY'],
    trust: 'unknown',
    docsUrl: 'https://docs.x.ai',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://x.ai/legal/privacy-policy'),
    defaultPricing: METERED,
  },

  /* ---------------- Media ---------------- */
  {
    id: 'pollinations',
    name: 'Pollinations',
    kinds: ['image', 'llm'],
    adapter: 'pollinations',
    baseUrl: 'https://image.pollinations.ai',
    auth: 'none',
    envKeys: [],
    trust: 'unknown',
    docsUrl: 'https://github.com/pollinations/pollinations',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified(
      'https://github.com/pollinations/pollinations',
      'An open, keyless public endpoint. Treat anything sent here as public. Not suitable for private code or personal data.',
    ),
    defaultPricing: FREE,
    notes: 'Genuinely keyless. Best-effort capacity with no availability guarantee.',
  },
  {
    id: 'ai-horde',
    name: 'AI Horde',
    kinds: ['image'],
    adapter: 'ai-horde',
    baseUrl: 'https://stablehorde.net/api/v2',
    auth: 'api-key',
    envKeys: ['AI_HORDE_API_KEY', 'STABLEHORDE_API_KEY'],
    trust: 'unknown',
    docsUrl: 'https://stablehorde.net/api/',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified(
      'https://stablehorde.net/faq',
      'Work is executed by volunteer workers you do not control. Do not send private or sensitive prompts.',
    ),
    defaultPricing: FREE,
    notes: 'Crowdsourced. Anonymous requests are heavily deprioritised; register a key for usable queue times.',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kinds: ['llm', 'image'],
    adapter: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    auth: 'api-key',
    envKeys: ['HF_TOKEN', 'HUGGINGFACE_API_KEY', 'HUGGING_FACE_HUB_TOKEN'],
    trust: 'trusted',
    docsUrl: 'https://huggingface.co/docs/api-inference',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://huggingface.co/privacy'),
    defaultPricing: freeDaily(RATE_LIMITED_FREE_TIER),
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    kinds: ['llm', 'image'],
    adapter: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    auth: 'api-key',
    envKeys: ['CLOUDFLARE_API_TOKEN'],
    trust: 'trusted',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    local: false,
    supportsDiscovery: false,
    dataUse: unverified('https://www.cloudflare.com/privacypolicy/'),
    defaultPricing: freeDaily('Free daily allowance; usage beyond it is billed.'),
    notes: 'Needs an account id alongside the API token. Set CLOUDFLARE_ACCOUNT_ID.',
  },
  {
    id: 'fal',
    name: 'fal.ai',
    kinds: ['image', 'video'],
    adapter: 'fal',
    baseUrl: 'https://queue.fal.run',
    auth: 'api-key',
    envKeys: ['FAL_KEY', 'FAL_API_KEY'],
    trust: 'trusted',
    docsUrl: 'https://fal.ai/docs',
    local: false,
    supportsDiscovery: false,
    dataUse: unverified('https://fal.ai/privacy'),
    defaultPricing: METERED,
    notes: 'Pay-per-use only. There is no free tier.',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    kinds: ['image', 'video'],
    adapter: 'replicate',
    baseUrl: 'https://api.replicate.com/v1',
    auth: 'api-key',
    envKeys: ['REPLICATE_API_TOKEN'],
    trust: 'trusted',
    docsUrl: 'https://replicate.com/docs',
    local: false,
    supportsDiscovery: true,
    dataUse: unverified('https://replicate.com/privacy'),
    defaultPricing: METERED,
    notes: 'Billed per second of compute. There is no free tier.',
  },

  /* ---------------- Local ---------------- */
  {
    id: 'ollama',
    name: 'Ollama',
    kinds: ['local', 'llm', 'coding', 'embedding'],
    adapter: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    auth: 'none',
    envKeys: [],
    baseUrlEnvKeys: ['OLLAMA_HOST'],
    trust: 'verified',
    docsUrl: 'https://github.com/ollama/ollama',
    local: true,
    supportsDiscovery: true,
    dataUse: localDataUse,
    defaultPricing: LOCAL,
  },
  {
    id: 'vllm',
    name: 'vLLM',
    kinds: ['local', 'llm', 'coding'],
    adapter: 'openai-server',
    baseUrl: 'http://localhost:8000/v1',
    auth: 'none',
    envKeys: [],
    baseUrlEnvKeys: ['VLLM_BASE_URL'],
    trust: 'verified',
    docsUrl: 'https://docs.vllm.ai',
    local: true,
    supportsDiscovery: true,
    dataUse: localDataUse,
    defaultPricing: LOCAL,
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    kinds: ['local', 'llm', 'coding'],
    adapter: 'openai-server',
    baseUrl: 'http://localhost:8080/v1',
    auth: 'none',
    envKeys: [],
    baseUrlEnvKeys: ['LLAMACPP_BASE_URL'],
    trust: 'verified',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    local: true,
    supportsDiscovery: true,
    dataUse: localDataUse,
    defaultPricing: LOCAL,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kinds: ['local', 'llm', 'coding', 'embedding'],
    adapter: 'openai-server',
    baseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    envKeys: [],
    baseUrlEnvKeys: ['LMSTUDIO_BASE_URL'],
    trust: 'verified',
    docsUrl: 'https://lmstudio.ai/docs',
    local: true,
    supportsDiscovery: true,
    dataUse: localDataUse,
    defaultPricing: LOCAL,
  },
];

export function catalogById(id: string): ProviderDescriptor | null {
  return PROVIDER_CATALOG.find((p) => p.id === id) ?? null;
}

/**
 * Parse OpenRouter's published per-model pricing, which arrives as decimal
 * strings in USD per token. A model whose input and output rates are both zero
 * is genuinely free on that route, which is why FREE is only assigned here —
 * from data the provider published — and never assumed.
 */
export function openRouterPricing(raw: Record<string, unknown>): Pricing {
  const p = raw.pricing as Record<string, unknown> | undefined;
  const perToken = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n * 1_000_000 : null;
  };
  const input = perToken(p?.prompt);
  const output = perToken(p?.completion);
  const request = perToken(p?.request);
  const image = perToken(p?.image);
  const free = (input ?? 0) === 0 && (output ?? 0) === 0 && (request ?? 0) === 0 && (image ?? 0) === 0;
  return {
    kind: free ? 'FREE' : 'METERED',
    inputPerMTok: input,
    outputPerMTok: output,
    perRequest: request != null && request > 0 ? request / 1_000_000 : null,
    note: free ? 'Published at zero cost on this route. Free routes are usually rate limited.' : null,
  };
}
