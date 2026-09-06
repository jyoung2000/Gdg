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

Each of these is a test that fails if the rule stops holding, not a paragraph.
Most live in `tests/contract/providers.test.ts`, which runs against the whole
catalog, and `tests/contract/router-invariants.test.ts`, which asserts the
routing rules over 400 generated registries rather than the handful someone
thought to write down.

| Rule | How it holds |
| --- | --- |
| No fake support | A provider is `supported` only when an adapter exists, a credential resolves, **and** capabilities were confirmed by a live call. Otherwise it reads `not configured`, `not verified` or `unavailable`. A modality with no adapter method is not routable. |
| No mislabelled free tiers | `TRIAL` and `CREDIT` are never rendered as "Free". A rate-limited allowance is `FREE_DAILY`, not `FREE`. |
| No guessed data-use policies | The shipped catalog says `unknown` for every remote provider and links to their own terms. You record what you verified. |
| No silent spending | Paid routing needs the instance switch **and** per-request permission. Budgets are hard ceilings. |
| No invented measurements | A model that has never been measured shows "Not measured", never a zero. |
| No secret harvesting | Automatic discovery reads documented environment variables and nothing else — no browser storage, no other applications' config, no cloud metadata, no repositories. |
| No silent data loss | Every agent write records its previous content; Reject restores it byte-for-byte, and a checkpoint before each step means a run can be taken back one agent at a time. |
| No unverified claims | What has been verified, what has not, and why is written down in `docs/FINAL_VERIFICATION_REPORT.md`. `pnpm verify:release` regenerates the gate table from a run. |

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
tests/      unit · router · contract · integration · e2e · chaos · live
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
so the router cannot select it for something it cannot do — and the contract
suite fails if any adapter ever advertises a surface it has no method for.

None of the twenty remote providers has been exercised against its real API in
this repository's environment: no credential is present here. They are
`IMPLEMENTED_UNVERIFIED`, which is neither working nor broken, and
`docs/PROVIDER_VERIFICATION.md` says so provider by provider. `pnpm test:live`
converts that into a measured matrix the moment a key is available.

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
pnpm test              # 237 tests, nothing outside this machine
pnpm test:router       # routing, fallback, pools, credentials
pnpm test:contract     # the provider contract and the router's invariants
pnpm test:e2e          # the gateway against a real inference server, over a real socket
pnpm test:ui           # every screen in a real browser, against a real gateway
pnpm test:chaos        # provider loss, key rotation, restarts, resource limits
pnpm verify:release    # everything, then a gate-by-gate report you can check
pnpm test:live         # real providers — refuses to spend without explicit permission and a ceiling
```

Three layers, and the difference between them matters.

**Simulated, in process.** Provider behaviour that no real provider will produce
on demand: a 429 on the sixth call, a stream that hangs forever, a failure every
third request. This is how routing and recovery are verified rather than hoped
for.

**Real, over a socket.** `scripts/local-model-server.mjs` is a dependency-free
OpenAI-compatible server — real SSE, real index-keyed tool-call fragments, real
usage accounting — that the gateway discovers and routes to like any local
inference server. Its responses come from a rule-based policy rather than a
model, so what it verifies is Meridian: routing, streaming, tool-call assembly,
the agent loop, workspace mutation, fallback, cancellation. It says nothing
about model quality, and nothing in this repository claims otherwise.

**Real providers.** `pnpm test:live` sends real requests with real credentials.
Nothing runs without one; nothing that can charge runs unless
`ALLOW_PAID_LIVE_TESTS=true` and `LIVE_TEST_MAX_COST_USD` names a ceiling the
suite tracks against reported usage and stops at.

**A real browser.** Every screen is opened in Chromium against a running
gateway and asked whether it rendered, whether it logged an error, and whether
it fits at 390, 834 and 1440 pixels. Screenshots land in
`docs/evidence/screens/`.

What has and has not been verified is written down rather than implied — see
`docs/FINAL_VERIFICATION_REPORT.md` and the matrices beside it.

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
| `docs/FINAL_VERIFICATION_REPORT.md` | What is verified, what is not, and the release classification |
| `docs/VERIFICATION_MATRIX.md` | Every capability with its status and its evidence |
| `docs/GAP_ANALYSIS.md` | What the second pass found, closed, and left open |
| `docs/PROVIDER_VERIFICATION.md` | Every provider and the status of its integration |
| `docs/AGENT_VERIFICATION.md` | The agent roster, and what each has been observed doing |
| `docs/MODALITY_VERIFICATION.md` | How far each modality's path has been exercised |

---

## Licence

MIT.
