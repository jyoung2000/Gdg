# Reasoning effort

Meridian can ask a reasoning-capable model to think harder or less hard before
it answers, and expose that control in the GUI, the CLI and the API. This is a
real request parameter that reaches the provider — not a display toggle.

## What it is

One canonical setting with four levels — `minimal`, `low`, `medium`, `high` —
plus "default", which sends nothing and leaves the provider's own behaviour in
place. Each level is translated into whatever the target provider actually
accepts:

| Provider family | What Meridian sends |
| --- | --- |
| OpenAI-compatible (OpenAI, xAI, Groq reasoning models, Gemini's OpenAI surface, …) | `reasoning_effort: "<level>"` on the request body |
| Anthropic | `thinking: { type: "enabled", budget_tokens: N }`, with `max_tokens` lifted above the budget and `temperature`/`top_p` dropped (the API rejects them together with thinking) |

The Anthropic budgets are `minimal → 1024`, `low → 4000`, `medium → 10000`,
`high → 24000` output tokens.

## The capability gate

The value is only ever sent to a model that reports the `reasoning` capability.
The gate lives in the executor (`packages/routing-sdk/src/executor.ts`), which
is the first point where the concrete model is known — under AUTO the model is
not chosen until routing. A chat-only model has the parameter **stripped**
before the request is built, so it is never handed something it would reject.
The user's intent is read as "think harder if you can", not "fail if you can't".

## Where to set it

- **GUI — chat composer.** A small **Effort** dropdown sits next to the Agent
  Mode selector. It is remembered across visits (a harmless preference), and
  labelled as applying to reasoning models. `default` sends nothing.
- **CLI.** `uag chat "…" --effort high`. Also accepted on `code`/`task` flows
  via the same flag plumbing.
- **API.** Either OpenAI's own top-level field or the Meridian namespace:
  ```json
  { "model": "auto", "messages": [...], "reasoning_effort": "high" }
  { "model": "auto", "messages": [...], "meridian": { "reasoning_effort": "high" } }
  ```
  An unrecognised value is ignored rather than rejected — effort is an
  optimisation, not a gate.

## How it was verified

`tests/router/reasoning-effort.test.ts`, over real sockets:

- A reasoning-capable model receives `reasoning_effort: "high"` verbatim —
  asserted against the exact body the mock provider recorded.
- A model **without** the reasoning capability does **not** receive the
  parameter (the executor gate strips it).
- With no effort requested, the field is absent entirely.
- Against a real Anthropic-shaped endpoint, `medium` becomes a `thinking` block
  with the 10k budget, `max_tokens` is lifted above it, and `temperature` /
  `top_p` are dropped — with all three restored to normal when no effort is set.

## Deliberate limits

- The control is **per request** (the composer / the API call), not a stored
  per-model default. A saved-per-model default would need the effective-config
  plumbing and is not built; the composer preference is the closest thing and
  is remembered client-side.
- Under AUTO, whether the parameter actually takes effect depends on which model
  the router picks — a non-reasoning pick silently drops it. Pin a
  reasoning-capable model if the effort must apply.
