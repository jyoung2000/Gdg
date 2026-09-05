# Architecture

## One process, one port

Meridian is a single node by design. The gateway serves the web client, the
OpenAI-compatible API, the Anthropic-compatible API, the admin API and the
event stream on port **4639**.

Splitting this into services would add deployment surface — service discovery,
inter-service auth, N health checks, N log streams — without buying anything
for a self-hosted product that runs on one machine. The modularity that
matters is in the package boundaries, not in process boundaries.

```
apps/
  gateway/     Fastify server, routes, SQLite store, service container
  web/         React client
  cli/         `uag`

packages/
  shared/        Domain types, error taxonomy, redaction, cost, config
  provider-sdk/  Adapter interface, HTTP layer, 11 adapters, catalog
  model-sdk/     Model registry, scoring, benchmarks, capability heuristics
  routing-sdk/   Health, credentials, pools, policy, router, executor
  agent-sdk/     Sandbox, workspace, tools, agents, loop, orchestrator
  media-sdk/     Image, video, speech, transcription jobs
  ui/            Design system: tokens, primitives, layouts, components, patterns
```

## Dependency direction

```
shared  ←  provider-sdk  ←  routing-sdk  ←  agent-sdk
   ↑            ↑              ↑   ↑
   └── model-sdk ┘              media-sdk
                                 ↑
                              gateway  →  web (types only)
```

`shared` depends on nothing. The SDKs depend on `shared` and each other in one
direction. The gateway depends on all of them and is the only package that
knows about HTTP or SQL.

That is what makes the router testable: it takes a `ModelRegistry`, a
`HealthStore`, a `CredentialResolver` and a `PoolManager` as constructor
arguments, so the test suite hands it in-memory implementations and a
controllable clock — no database, no network, no real time.

## Request path

```
HTTP  →  route handler
             │  normalises to AIRequest
             ▼
         Executor
             │  asks Router for a decision
             ▼
         Router
             │  phase 1: remove what cannot serve
             │  phase 2: score the survivors
             ▼
         RoutingDecision  ─ provider, model, credential, pool, fallback chain,
             │              reason, expected cost and latency
             ▼
         Executor
             │  resolves the credential, acquires concurrency slots
             │  calls the adapter, records health and usage
             │  on failure: retry, or fail over, within one shared budget
             ▼
         ProviderAdapter  →  the provider's HTTP API
```

## Key decisions

**SQLite, not a server database.** One file, one volume, no operational
surface. WAL with `synchronous = NORMAL`: a crash can lose the last transaction
but never corrupts the file, and it removes an fsync per write. Migrations are
plain `.sql` applied in filename order inside one transaction each and recorded
in `_migrations`, so restart is idempotent and a volume survives an upgrade.

**Internal packages are consumed as TypeScript source.** No per-package build
step, so there is exactly one bundling step per deployable — esbuild for the
two Node entry points, Vite for the client. It removes a whole class of
stale-build problems from a workspace this size.

**Capability declarations gate routing.** A `ProviderAdapter` implements only
the methods for the modalities it genuinely serves, and the router checks for
the method before considering a candidate. "No fake support" is therefore
structural, not a promise.

**Errors are classified once.** `packages/shared/src/errors.ts` maps every
failure to a code carrying whether to retry, whether to fail over, and how long
to cool the provider down. Adapters translate their own transport errors into
that taxonomy; nothing downstream inspects a raw provider error.

**The event bus is in-process.** A single-node product does not need a broker.
A slow subscriber is dropped rather than allowed to block a publisher — a
stalled WebSocket must never stall a task.

**Streams are bounded by silence, not by a deadline.** A total timeout is the
wrong tool for a stream: a long generation is not a stalled one. `sseLines`
uses an idle deadline that resets on every chunk, and cancels the reader to
tear the connection down. (An earlier version raced the idle timer against the
read *and* cancelled the reader — which resolved the pending read as a clean
end-of-stream and won the race, turning a stall into a silent success. The
cancel now happens only in the teardown path.)

**Generated media lives under `/media/`, not `/assets/`.** Vite emits the web
bundle into `/assets/`, and two static roots on one prefix resolve by
registration order — which works until a rebuild changes a bundle filename.

## Data model

`users`, `user_preferences`, `api_keys`, `workspaces`, `providers`,
`credentials`, `credential_pools`, `models`, `model_scores`,
`model_performance`, `benchmarks`, `provider_health`, `inference_pools`,
`reservations`, `routing_policies`, `agents`, `tasks`, `task_steps`,
`tool_calls`, `sessions`, `usage`, `quotas`, `generation_jobs`, `audit_logs`,
`settings`.

Everything routing needs is also held in memory at runtime; the database is the
durable record and the source of truth across restarts.

## Testing strategy

| Suite | What it proves |
| --- | --- |
| `tests/unit` | Redaction, encryption, path containment, diffing, glob, cost, pricing honesty, capability inference |
| `tests/router` | Hard constraints, mode behaviour, explanations, fallback, circuit breaker, retry budget, pools, reservations, credential precedence, stream safety |
| `tests/integration` | The real gateway: discovery → routing → both APIs, credential secrecy, sandbox isolation, path containment through HTTP |
| `tests/chaos` | Provider disappearance, credential expiry and rotation, restart persistence, lost master key, runaway commands, unbounded output, SSRF targets |

Providers are simulated deterministically — one that 429s after N calls, one
that hangs forever, one that fails every third request — because no real
provider will reliably do that on demand.
