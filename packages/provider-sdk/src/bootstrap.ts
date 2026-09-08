import type { Pricing, ProviderDescriptor } from '@meridian/shared';
import type { AdapterSurface } from './adapter.js';
import { ProviderRegistry } from './registry.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleOptions } from './adapters/openai-compatible.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { GenericOpenAIServerAdapter, OllamaAdapter } from './adapters/ollama.js';
import { PollinationsAdapter } from './adapters/pollinations.js';
import { AIHordeAdapter } from './adapters/ai-horde.js';
import { HuggingFaceAdapter } from './adapters/huggingface.js';
import { CloudflareWorkersAIAdapter } from './adapters/cloudflare.js';
import { FalAdapter } from './adapters/fal.js';
import { ReplicateAdapter } from './adapters/replicate.js';
import { PROVIDER_CATALOG, openRouterPricing } from './catalog.js';

/**
 * Which OpenAI-compatible surfaces each provider actually serves.
 *
 * This table is the enforcement point for "no fake support": a surface absent
 * here is absent from the adapter's capability set, so the router will never
 * select that provider for it. Entries are conservative — a surface is only
 * listed when the provider documents it. Being wrong in the cautious direction
 * costs a routing option; being wrong in the optimistic direction produces a
 * runtime failure the user cannot explain.
 */
const OPENAI_SURFACES: Record<string, Partial<OpenAICompatibleOptions['supports']>> = {
  openrouter: { chat: true, streaming: true, tools: true, vision: true, discovery: true },
  groq: { chat: true, streaming: true, tools: true, vision: true, transcription: true, discovery: true },
  cerebras: { chat: true, streaming: true, tools: true, discovery: true },
  sambanova: { chat: true, streaming: true, tools: true, discovery: true },
  together: { chat: true, streaming: true, tools: true, vision: true, embedding: true, image: true, discovery: true },
  fireworks: { chat: true, streaming: true, tools: true, vision: true, embedding: true, image: true, discovery: true },
  hyperbolic: { chat: true, streaming: true, tools: true, image: true, discovery: true },
  nvidia: { chat: true, streaming: true, tools: true, embedding: true, discovery: true },
  openai: {
    chat: true,
    streaming: true,
    tools: true,
    vision: true,
    embedding: true,
    image: true,
    speech: true,
    transcription: true,
    discovery: true,
  },
  deepseek: { chat: true, streaming: true, tools: true, discovery: true },
  mistral: { chat: true, streaming: true, tools: true, vision: true, embedding: true, discovery: true },
  xai: { chat: true, streaming: true, tools: true, vision: true, discovery: true },
};

/** Attribution headers some aggregators ask integrators to send. */
const STATIC_HEADERS: Record<string, Record<string, string>> = {
  openrouter: {
    'http-referer': 'https://github.com/meridian-gateway',
    'x-title': 'Meridian Universal AI Gateway',
  },
};

const LOCAL_SERVER_SURFACES: Partial<AdapterSurface> = {
  chat: true,
  streaming: true,
  tools: true,
  embedding: true,
  discovery: true,
};

export interface BootstrapOptions {
  /** Extra descriptors, e.g. local endpoints discovered at runtime. */
  extraProviders?: ProviderDescriptor[];
  /** Resolves catalog pricing for a specific model, when known. */
  pricingLookup?: (providerId: string, providerModelId: string) => Pricing | null;
  /** Environment to read endpoint overrides from. Injected for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a registry with every adapter implementation wired up and every catalog
 * provider registered.
 *
 * Registering a provider is not the same as enabling it: without a credential
 * the registry reports it as `not_configured`, and the router skips it.
 */
export function createRegistry(opts: BootstrapOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry();
  const lookupFor = (providerId: string) => (providerModelId: string): Pricing | null =>
    opts.pricingLookup?.(providerId, providerModelId) ?? null;

  registry.registerAdapter('openai-compatible', (d) => {
    const adapter = new OpenAICompatibleAdapter(d, {
      supports: OPENAI_SURFACES[d.id] ?? { chat: true, streaming: true, discovery: d.supportsDiscovery },
      staticHeaders: STATIC_HEADERS[d.id],
      // OpenRouter is the one provider that publishes real per-model rates in
      // its listing, so discovered models get accurate pricing rather than the
      // descriptor's posture.
      pricingForDiscovered: d.id === 'openrouter' ? (raw) => openRouterPricing(raw) : undefined,
    });
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('openai-server', (d) => {
    const adapter = new GenericOpenAIServerAdapter(d, LOCAL_SERVER_SURFACES);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  // Ollama declares its own capability set from its native API rather than
  // taking one, so it needs no surface table.
  registry.registerAdapter('ollama', (d) => new OllamaAdapter(d));

  registry.registerAdapter('anthropic', (d) => {
    const adapter = new AnthropicAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('gemini', (d) => {
    const adapter = new GeminiAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('pollinations', (d) => new PollinationsAdapter(d));
  registry.registerAdapter('ai-horde', (d) => new AIHordeAdapter(d));

  registry.registerAdapter('huggingface', (d) => {
    const adapter = new HuggingFaceAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('cloudflare', (d) => {
    const adapter = new CloudflareWorkersAIAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('fal', (d) => {
    const adapter = new FalAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  registry.registerAdapter('replicate', (d) => {
    const adapter = new ReplicateAdapter(d);
    adapter.setPricingLookup(lookupFor(d.id));
    return adapter;
  });

  for (const d of PROVIDER_CATALOG) registry.registerProvider(withEnvBaseUrl(d, opts.env ?? process.env));
  for (const d of opts.extraProviders ?? []) registry.registerProvider(withEnvBaseUrl(d, opts.env ?? process.env));

  return registry;
}

/**
 * Apply an operator's endpoint override.
 *
 * A self-hosted server does not have to be on the port the catalog assumes, and
 * the override is a URL, not a secret — keeping the two apart matters, because
 * anything in `envKeys` is read as a credential, sealed, and sent as this
 * provider's key.
 */
function withEnvBaseUrl(descriptor: ProviderDescriptor, env: NodeJS.ProcessEnv): ProviderDescriptor {
  for (const key of descriptor.baseUrlEnvKeys ?? []) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    // OLLAMA_HOST is conventionally a bare host or host:port, so a missing
    // scheme is the documented form rather than a mistake.
    const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url: URL;
    try {
      // Parsed rather than trusted: a malformed value would otherwise surface
      // much later as an unexplained request failure.
      url = new URL(candidate);
    } catch {
      continue;
    }

    let base = candidate.replace(/\/+$/, '');
    // A host with no path, where the catalog's default carries one, means the
    // operator moved the server rather than restructured its API.
    if ((url.pathname === '/' || url.pathname === '') && descriptor.baseUrl.endsWith('/v1')) base = `${base}/v1`;
    return { ...descriptor, baseUrl: base };
  }
  return descriptor;
}

/**
 * Find credentials the operator has legitimately made available through the
 * process environment.
 *
 * This is the whole of Meridian's automatic credential discovery. It reads the
 * environment variables each provider documents and nothing else — it does not
 * read browser storage, shell histories, cloud metadata services, other
 * applications' config files, or any repository. A credential that is not in
 * the environment must be entered explicitly.
 */
export function discoverEnvCredentials(
  descriptors: ProviderDescriptor[],
  env: NodeJS.ProcessEnv = process.env,
): { providerId: string; envKey: string; secret: string }[] {
  const found: { providerId: string; envKey: string; secret: string }[] = [];
  for (const d of descriptors) {
    for (const key of d.envKeys) {
      const value = env[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        found.push({ providerId: d.id, envKey: key, secret: value.trim() });
        break; // First documented key wins; the rest are aliases.
      }
    }
  }
  return found;
}
