# Provider verification

Every provider Meridian ships, what it is wired to serve, and the status of
that claim. Generated from the catalog and the adapters themselves, not from
memory: the surface column is the adapter's own capability set, which the
contract suite checks against the methods that actually exist.

## Status vocabulary

| Status | Means |
| --- | --- |
| VERIFIED | A real request was sent to this provider and it answered as expected |
| IMPLEMENTED_UNVERIFIED | The adapter exists and satisfies the contract suite; no live request has been sent |
| BLOCKED_EXTERNAL | Cannot be exercised here — no credential, or the host is unreachable under this environment's egress policy |

Nothing below is VERIFIED. No provider credential is present in this
environment and most provider hosts are unreachable from it, so not one remote
provider has been exercised against its real API. That is the honest state; it
is not a defect in the adapters and it is not evidence that they work.

Run `pnpm test:live` with credentials to produce the live matrix at
`docs/evidence/PROVIDER_LIVE.md`.

## Catalog

| Provider | Adapter | Auth | Trust | Pricing | Surfaces declared | Status |
| --- | --- | --- | --- | --- | --- | --- |
| OpenRouter (`openrouter`) | `openai-compatible` | api-key | trusted | METERED | chat, streaming, tools, vision, discovery, health | BLOCKED_EXTERNAL |
| Groq (`groq`) | `openai-compatible` | api-key | trusted | FREE_DAILY | chat, streaming, tools, vision, transcription, discovery, health | BLOCKED_EXTERNAL |
| Cerebras (`cerebras`) | `openai-compatible` | api-key | trusted | FREE_DAILY | chat, streaming, tools, discovery, health | BLOCKED_EXTERNAL |
| SambaNova (`sambanova`) | `openai-compatible` | api-key | unknown | FREE_DAILY | chat, streaming, tools, discovery, health | BLOCKED_EXTERNAL |
| Together AI (`together`) | `openai-compatible` | api-key | trusted | METERED | chat, streaming, tools, vision, embedding, image, discovery, health | BLOCKED_EXTERNAL |
| Fireworks AI (`fireworks`) | `openai-compatible` | api-key | trusted | METERED | chat, streaming, tools, vision, embedding, image, discovery, health | BLOCKED_EXTERNAL |
| Hyperbolic (`hyperbolic`) | `openai-compatible` | api-key | unknown | METERED | chat, streaming, tools, image, discovery, health | BLOCKED_EXTERNAL |
| NVIDIA NIM (`nvidia`) | `openai-compatible` | api-key | trusted | FREE_DAILY | chat, streaming, tools, embedding, discovery, health | BLOCKED_EXTERNAL |
| Anthropic (`anthropic`) | `anthropic` | api-key | trusted | METERED | chat, streaming, tools, vision, discovery, health | BLOCKED_EXTERNAL |
| OpenAI (`openai`) | `openai-compatible` | api-key | trusted | METERED | chat, streaming, tools, vision, embedding, image, speech, transcription, discovery, health | BLOCKED_EXTERNAL |
| Google AI Studio (`google`) | `gemini` | api-key | trusted | FREE_DAILY | chat, streaming, tools, vision, embedding, discovery, health | BLOCKED_EXTERNAL |
| DeepSeek (`deepseek`) | `openai-compatible` | api-key | unknown | METERED | chat, streaming, tools, discovery, health | BLOCKED_EXTERNAL |
| Mistral (`mistral`) | `openai-compatible` | api-key | trusted | METERED | chat, streaming, tools, vision, embedding, discovery, health | BLOCKED_EXTERNAL |
| xAI (`xai`) | `openai-compatible` | api-key | unknown | METERED | chat, streaming, tools, vision, discovery, health | BLOCKED_EXTERNAL |
| Pollinations (`pollinations`) | `pollinations` | none | unknown | FREE | chat, image, discovery, health | BLOCKED_EXTERNAL |
| AI Horde (`ai-horde`) | `ai-horde` | api-key | unknown | FREE | image, discovery, health | BLOCKED_EXTERNAL |
| Hugging Face (`huggingface`) | `huggingface` | api-key | trusted | FREE_DAILY | chat, streaming, tools, vision, image, discovery, health | BLOCKED_EXTERNAL |
| Cloudflare Workers AI (`cloudflare`) | `cloudflare` | api-key | trusted | FREE_DAILY | chat, streaming, image, health | BLOCKED_EXTERNAL |
| fal.ai (`fal`) | `fal` | api-key | trusted | METERED | image, video, health | BLOCKED_EXTERNAL |
| Replicate (`replicate`) | `replicate` | api-key | trusted | METERED | image, video, discovery, health | BLOCKED_EXTERNAL |
| Ollama (`ollama`) | `ollama` | none | verified | LOCAL | chat, streaming, tools, vision, embedding, discovery, health | IMPLEMENTED_UNVERIFIED |
| vLLM (`vllm`) | `openai-server` | none | verified | LOCAL | chat, streaming, tools, embedding, discovery, health | IMPLEMENTED_UNVERIFIED |
| llama.cpp (`llamacpp`) | `openai-server` | none | verified | LOCAL | chat, streaming, tools, embedding, discovery, health | IMPLEMENTED_UNVERIFIED |
| LM Studio (`lmstudio`) | `openai-server` | none | verified | LOCAL | chat, streaming, tools, embedding, discovery, health | IMPLEMENTED_UNVERIFIED |

## What "IMPLEMENTED_UNVERIFIED" covers for the local adapters

The `openai-server` adapter — the one behind vLLM, llama.cpp and LM Studio — is
the same class that was exercised end to end against a real OpenAI-compatible
server on a real socket: discovery, chat, streaming, index-keyed tool-call
fragments, embeddings and usage accounting all crossed a process boundary and a
socket. See `tests/e2e/live-inference.test.ts`.

That is strong evidence for the *wire protocol* and for Meridian's own handling
of it, and it is not evidence that any particular server (vLLM, llama.cpp, LM
Studio, Ollama) behaves identically. Their adapters are therefore
IMPLEMENTED_UNVERIFIED rather than VERIFIED. The distinction is the point.

## What the contract suite does establish, for every row above

`tests/contract/providers.test.ts` runs against the whole catalog and fails if
any of these stop holding:

- No adapter advertises a surface it has no method for. A provider without an
  `image` method cannot be routed image work, structurally.
- No remote provider states a data-use policy without linking one, and none
  guesses: `unknown` is the default and stays there until a policy is read.
- No trial balance or promotional credit is counted as free capacity the router
  may spend from.
- Nothing requiring a credential reports itself usable before one is supplied.
- No environment variable is read that the documentation does not explain, and
  no endpoint variable is read as a credential.
- Every remote base URL is `https`.

## Surfaces by provider count

| Surface | Providers declaring it |
| --- | --- |
| health | 24 |
| discovery | 22 |
| chat | 21 |
| streaming | 20 |
| tools | 19 |
| vision | 11 |
| embedding | 10 |
| image | 10 |
| transcription | 2 |
| video | 2 |
| speech | 1 |
