# Modality verification

What each modality's path does, and how far it has actually been exercised.

The distinction that matters throughout: Meridian's *own* path for a modality —
request mapping, routing, transport, response mapping, asset handling, usage —
can be verified without a provider that serves it, and has been where a local
server could stand in. Whether a *provider* serves it can only be verified
against that provider.

| Modality | Meridian's path | A provider serving it | Evidence |
| --- | --- | --- | --- |
| Text / chat | VERIFIED | VERIFIED (local) | Completions over both surfaces, real usage, real token counts |
| Streaming | VERIFIED | VERIFIED (local) | Multi-chunk SSE, terminated with `[DONE]`, headers intact on the raw socket |
| Tool calling | VERIFIED | VERIFIED (local) | Arguments fragmented mid-JSON reassemble into the right object, on both surfaces |
| Vision (image input) | VERIFIED | BLOCKED_EXTERNAL | A 1×1 PNG sent through both surfaces arrives at the provider with its media type and byte count intact |
| Embeddings | VERIFIED | VERIFIED (local) | Real vectors of a consistent width; identical inputs give identical vectors, so a batch cannot be shuffled or truncated unnoticed |
| Image generation | IMPLEMENTED_UNVERIFIED | BLOCKED_EXTERNAL | Job lifecycle and refusal verified; no image provider is configured |
| Video generation | IMPLEMENTED_UNVERIFIED | BLOCKED_EXTERNAL | As above |
| Speech synthesis | IMPLEMENTED_UNVERIFIED | BLOCKED_EXTERNAL | As above |
| Transcription | IMPLEMENTED_UNVERIFIED | BLOCKED_EXTERNAL | As above |

## What was verified for vision without a vision provider

The mapping is the part that is easy to get wrong and impossible to check by
reading: OpenAI expresses an image as `image_url` with a data URI, Anthropic as
a `source` object with a media type and base64 payload, and Meridian has to
carry either into its internal form and back out to whichever provider it routes
to.

The local inference server reports exactly what arrived — kind, media type and
decoded byte count — so a test can send the same PNG through both surfaces and
assert it reached the provider whole. A truncated payload, a lost media type or
a dropped part fails that assertion. What it does not establish is that any
model can see the image.

## What "IMPLEMENTED_UNVERIFIED" means for image, video, speech and transcription

The engine exists and is wired end to end: `POST /api/generations/image`,
`video`, `speech` and `transcribe` create a job, route it, run it, write assets
under the asset root, serve them from `/media/`, publish progress on the event
stream, and support cancellation. The OpenAI-compatible equivalents
(`/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`) route
through the same engine.

What has been observed here is the refusal path, which is the honest half:

```
POST /api/generations/speech  →  job queued  →  job failed
  "No model can serve a speech/speech-synthesis request under mode AUTO and
   privacy TRUSTED_ONLY. Most common reasons: Does not serve speech (n)."
```

That is the correct behaviour — a clear, specific failure rather than a
fabricated asset — and it is not evidence that generation works.

Ten providers declare image generation (Together AI, Fireworks AI, Hyperbolic,
OpenAI, Pollinations, AI Horde, Hugging Face, Cloudflare Workers AI, fal.ai,
Replicate), two declare video (fal.ai, Replicate), one declares speech (OpenAI)
and two declare transcription (Groq, OpenAI). None is credentialed here.

To verify any of them, set that provider's key and run `pnpm test:live`.

## Asset handling

| Behaviour | Status | Note |
| --- | --- | --- |
| Assets written under the configured asset root | IMPLEMENTED_UNVERIFIED | No generation has produced one here |
| Assets served from `/media/`, not `/assets/` | VERIFIED | The route is registered separately from the web bundle, which is what stops a rebuild from shadowing it |
| Generated media served with a long cache lifetime | IMPLEMENTED_UNVERIFIED | Filenames carry the job id, so the content is immutable |
| Job cancellation | IMPLEMENTED_UNVERIFIED | The abort controller is wired; no long-running job existed to cancel |
