# Meridian

**Universal AI Gateway.** One interface for every model, provider and modality —
coding, chat, reasoning, vision, images, video, audio, speech, embeddings,
research and local inference — behind one gateway, one model registry, one
routing engine, one credential manager and one API.

```
docker compose up -d   →   http://localhost:4639
```

The default experience is: describe what you want, and Meridian works out what
is needed, picks the best available model, runs it, recovers from provider
failures, and hands back the result. Nothing about the underlying
infrastructure is required knowledge. Everything about it is available when you
want it.

---

## What it does

**Routes.** One request is normalised, scored against every model that could
serve it, and sent to the best one under the mode you chose — `AUTO`, `BEST`,
`FAST`, `CHEAP`, `FREE`, `LOCAL`, or one of nine explicit policies. Every
response carries the reasoning: what was chosen, what was considered, and what
was ruled out by which rule.

**Recovers.** Rate limits, timeouts, 5xx, exhausted quota, rejected credentials
and withdrawn models are all handled by one fallback engine with a shared retry
budget, a circuit breaker per provider, and cooldowns that honour a provider's
own `Retry-After`. A recovered failure is reported calmly, not as an incident.

**Never spends money by accident.** Paid routing is off until an operator
enables it *and* a request asks for it. A trial credit is never labelled
"free". Pools can be given a hard daily ceiling, including zero.

**Runs agents.** A coding request is decomposed across specialists — file
finder, planner, implementer, tester, reviewer, debugger — each routed to a
model that suits its job and its economics. Every change is recorded with its
previous content and can be reverted exactly until you accept it.

**Speaks the APIs you already use.** An OpenAI-compatible surface at `/v1` and
an Anthropic-compatible surface at `/anthropic/v1`. Point any OpenAI SDK, or
Claude Code, at Meridian and it routes across every provider you have
configured.

---

## Quick start

### Docker

```bash
git clone <this repository> meridian && cd meridian
cp .env.example .env          # optional; Meridian starts with no configuration
docker compose up -d
open http://localhost:4639
```

Optionally build the sandbox image agent commands run inside:

```bash
docker compose --profile build-sandbox build sandbox-image
```

### From source

```bash
pnpm install
pnpm build
pnpm start          # http://localhost:4639
```

Development, with hot reload on both halves:

```bash
pnpm dev            # gateway on :4639, Vite dev server on :5173
```

### Connecting a provider

Meridian starts with **no** configuration and reports every provider as *not
configured* until it has a credential. Three ways to give it one:

1. **Environment.** Set any documented key — `OPENROUTER_API_KEY`,
   `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, and so on. They are discovered at
   startup and encrypted into the database.
2. **The app.** Providers → pick one → paste a key. It is encrypted at rest and
   never returned by the API again.
3. **Run something local.** Start Ollama, vLLM, llama.cpp or LM Studio and
   Meridian finds it, registers its models as `LOCAL`, and marks the provider
   `verified` — because nothing leaves your machine.

---

## Using it

### The app

`http://localhost:4639`. A three-panel workstation: navigation, workspace,
assistant. `⌘K` opens the command palette, which reaches everything.

### The CLI

```bash
uag status                                   # what this instance can do
uag chat "explain this stack trace"          # routed automatically
uag code "add retry logic to the http client" --workspace ws_123
uag models --free                            # what is routable, and free
uag providers                                # health, trust, model counts
uag benchmark groq:llama-3.3-70b-versatile   # measure it yourself
uag compare "write a debounce" --models a:1,b:2
uag image "a calm desk at dawn" --output desk.png
uag usage --days 7
```

### The OpenAI-compatible API

```bash
curl http://localhost:4639/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

`model` is optional. Omit it, or send `"auto"`, and Meridian chooses. A
`meridian` object steers routing without breaking a stock client:

```jsonc
{
  "messages": [{ "role": "user", "content": "refactor this" }],
  "meridian": {
    "mode": "FREE",          // AUTO | BEST | FAST | CHEAP | FREE | LOCAL | …
    "pool": "coding",
    "free_only": true,
    "budget": 0.05,
    "sensitive": true        // never route to an unverified provider
  }
}
```

Also available: `/v1/models`, `/v1/responses`, `/v1/embeddings`,
`/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`.

### The Anthropic-compatible API

```bash
export ANTHROPIC_BASE_URL=http://localhost:4639/anthropic
```

`/anthropic/v1/messages` with full streaming, tool use and
`/messages/count_tokens`. Any Messages-API client — Claude Code included — then
routes through Meridian to *any* model you have configured, not only
Anthropic's.

---

## How routing works

Selection is two phases.

**Phase one removes what cannot serve the request.** Wrong modality, missing
capability, context window too small, no adapter, no credential, provider
circuit open, trust level disallowed by the privacy mode, would spend money
without permission, would breach a pool's budget. Nothing that survives phase
one is a wrong answer.

**Phase two scores the survivors** on quality, speed, cost, free capacity,
locality, your preferences and provider reliability, weighted by the routing
mode.

The decision comes back with a fallback chain that deliberately prefers a
*different provider* first — the second-best model on a rate-limited provider
will fail identically.

Ask before committing:

```bash
curl -X POST http://localhost:4639/api/routing/preview \
  -H 'content-type: application/json' \
  -d '{"modality":"text","taskType":"coding","toolsRequired":true}'
```

Nothing is executed. You get the decision, the ranked candidates, and every
rejection with the rule that caused it.

---

## Honesty rules

These are enforced in code and covered by tests, not aspirations.

| Rule | How it holds |
| --- | --- |
| No fake support | A provider is `supported` only when an adapter exists, a credential resolves, **and** capabilities were confirmed by a live call. Otherwise it reads `not configured`, `not verified` or `unavailable`. A modality with no adapter method is not routable. |
| No mislabelled free tiers | `TRIAL` and `CREDIT` are never rendered as "Free". A rate-limited allowance is `FREE_DAILY`, not `FREE`. |
| No guessed data-use policies | The shipped catalog says `unknown` for every remote provider and links to their own terms. You record what you verified. |
| No silent spending | Paid routing needs the instance switch **and** per-request permission. Budgets are hard ceilings. |
| No invented measurements | A model that has never been measured shows "Not measured", never a zero. |
| No secret harvesting | Automatic discovery reads documented environment variables and nothing else — no browser storage, no other applications' config, no cloud metadata, no repositories. |
| No silent data loss | Every agent write records its previous content; Reject restores it byte-for-byte. |

---

## Architecture

One process serves everything on one port.

```
                    Web client  ·  CLI  ·  OpenAI API  ·  Anthropic API
                                        │
                                   Gateway :4639
                                        │
                    ┌───────────────────┼───────────────────┐
              Agent runtime        Routing engine       Media engine
                    │                   │                   │
            orchestrator          hard constraints      image · video
            planner · finder      then scoring          speech · audio
            implementer                │
            tester · reviewer     Inference pools
            debugger                   │
                    │             Fallback engine
              Sandbox              circuit breaker
                                        │
                                 Provider adapters
                                        │
                                   Credentials
                        user · workspace · admin · system · env
```

```
apps/       gateway (server, routes, db)  ·  web (React client)  ·  cli
packages/   shared · provider-sdk · model-sdk · routing-sdk
            agent-sdk · media-sdk · ui (design system)
design/     design system and UI documentation
database/   migrations
docker/     Dockerfile, sandbox image
tests/      unit · router · integration · chaos
```

The SDKs are pure and dependency-injected: the router is tested against
in-memory stores and simulated providers with a controllable clock, with no
database and no network.

---

## Providers

24 in the shipped catalog. Aggregators (OpenRouter), fast inference (Groq,
Cerebras, SambaNova), open-weight hosts (Together, Fireworks, Hyperbolic,
NVIDIA), first-party (OpenAI, Anthropic, Google, DeepSeek, Mistral, xAI), media
(Pollinations, AI Horde, Hugging Face, Cloudflare Workers AI, fal.ai,
Replicate) and local (Ollama, vLLM, llama.cpp, LM Studio).

Each has a real adapter. Each declares only the surfaces it genuinely serves,
so the router cannot select it for something it cannot do.

---

## Security

- **Credentials** are sealed with AES-256-GCM under a scrypt-derived key. They
  are never returned by the API, never written to a log, and absent from the
  sandbox environment, which is built from scratch rather than filtered.
- **Command execution** runs in a Docker sandbox with no network, a read-only
  root filesystem, dropped capabilities, and hard memory, CPU and process
  limits. Where Docker is unavailable Meridian falls back to a process sandbox
  and **says so** in the UI — it limits accidents but is not a security
  boundary.
- **The agent web-fetch tool** is off unless enabled, and refuses loopback,
  link-local and private-network addresses.
- **The gateway** sets a strict CSP (the one inline script is allowed by hash,
  not by `unsafe-inline`), rate limits, and redacts secrets from every log sink.

See `docs/SECURITY.md`.

---

## Testing

```bash
pnpm test              # 143 tests
pnpm test:router       # routing, fallback, pools, credentials
pnpm test:chaos        # provider loss, key rotation, restarts, resource limits
```

Provider behaviour is simulated deterministically — a provider that 429s after
N calls, one that hangs forever, one that fails every third request — so
routing and recovery are verified rather than hoped for.

---

## Documentation

| Document | What it covers |
| --- | --- |
| `docs/CONFIGURATION.md` | Every environment variable |
| `docs/API.md` | Both compatible APIs and the admin API |
| `docs/ARCHITECTURE.md` | How the pieces fit and why |
| `docs/SECURITY.md` | Threat model and the guarantees |
| `docs/ROUTING.md` | Modes, pools, reservations, economics |
| `docs/AGENTS.md` | The agent roster and the task pipeline |
| `design/DESIGN_SYSTEM.md` | Tokens, components, states, theming |
| `design/ACCESSIBILITY.md` | The accessibility contract, with measured contrast |

---

## Licence

MIT.
