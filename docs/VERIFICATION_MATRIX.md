# Verification matrix

Every capability Meridian claims, and what the evidence actually supports.

## Status vocabulary

These are not interchangeable and are not rounded up.

| Status | Means |
| --- | --- |
| VERIFIED | Exercised here, against the real thing, and it passed |
| IMPLEMENTED_UNVERIFIED | The code exists and is reviewed; nothing exercised it end to end here |
| PARTIAL | Part of it is verified and part is not; the row says which |
| BLOCKED_EXTERNAL | Cannot be exercised here for a reason outside the product — no credential, blocked egress. Never a synonym for "probably fine" |
| MISSING | Not implemented |
| STUB | A placeholder that returns something without doing the work |
| FAILED | Exercised and it did not pass |

Regenerate the gate-level view with `pnpm verify:release`, which writes
`docs/evidence/RELEASE.md` from a run rather than from a claim.

## Gateway and APIs

| Capability | Status | Evidence |
| --- | --- | --- |
| Single port serving web client, both APIs, admin API and events | VERIFIED | The E2E suite binds one port and uses all of them |
| OpenAI-compatible chat completions | VERIFIED | Real completion through the real gateway to a real inference server |
| OpenAI-compatible streaming | VERIFIED | Multi-chunk SSE, `[DONE]` terminated |
| OpenAI-compatible tool calling | VERIFIED | Arguments fragmented mid-JSON reassemble correctly |
| OpenAI-compatible embeddings | VERIFIED | Real vectors, consistent width, batch order preserved |
| OpenAI-compatible model listing | VERIFIED | Discovered models appear on `/v1/models` |
| OpenAI images, speech, transcription routes | IMPLEMENTED_UNVERIFIED | Route to the media engine; no capable provider configured |
| `/v1/responses` | IMPLEMENTED_UNVERIFIED | Maps onto the same completion path |
| Anthropic-compatible messages | VERIFIED | Text and `tool_use`, correct `stop_reason` |
| Anthropic-compatible streaming | VERIFIED | `message_start` → deltas → `message_stop`, in order |
| Anthropic `count_tokens` | IMPLEMENTED_UNVERIFIED | Reports an estimate and says so |
| Routing transparency on every response | VERIFIED | `meridian.routing` carries criteria, considered and rejected candidates |
| Server-sent events and WebSocket | PARTIAL | SSE headers and framing verified; the WebSocket transport is IMPLEMENTED_UNVERIFIED |
| Liveness (`/api/system/health`) | VERIFIED | — |
| Readiness (`/api/system/ready`) | VERIFIED | 200 with per-check detail; the checks are named and each says what it found |
| Onboarding state (`/api/onboarding`) | VERIFIED | Derived from live state; reports the process sandbox as not isolated |
| Idempotency keys | VERIFIED | Replay is byte-identical including the request id; reuse with a different body is refused; streaming says it does not apply |
| Rate limiting | IMPLEMENTED_UNVERIFIED | Per-credential/IP bucket with a sweeper; not driven to its limit here |
| Request size limits | VERIFIED | 2 MB default, media routes raised to `MERIDIAN_MAX_BODY_MB`, both sides asserted |
| API keys, hashed at rest | VERIFIED | Unit tests cover hashing and constant-time comparison |
| Audit log with redaction | VERIFIED | A stored credential never appears in it |

## Routing

| Capability | Status | Evidence |
| --- | --- | --- |
| Two-phase routing: hard constraints then weighted scoring | VERIFIED | 400 generated registries; every rejection carries a reason |
| Never selects a model that cannot serve the modality | VERIFIED | Invariant across all generated scenarios |
| Never spends without permission from both instance and request | VERIFIED | Invariant; expected cost is zero whenever paid routing is off |
| Budget honoured | VERIFIED | Invariant: expected cost never exceeds a set budget |
| 15 routing modes | VERIFIED | Every mode routes; the decision reports the requested mode and the policy applied |
| Mode aliasing reported honestly | VERIFIED | Choosing FAST shows FAST, applied as FASTEST |
| Privacy modes | VERIFIED | STRICT_LOCAL holds across the fallback chain, not just the first choice |
| Free-only routing | VERIFIED | FREE mode holds across the fallback chain |
| Tool-capability requirement | VERIFIED | Holds across the fallback chain |
| Fallback chain diversified by provider | VERIFIED | Every new provider is tried before any repeat |
| Deterministic decisions | VERIFIED | Same registry and request, same decision |
| Circuit breaker with escalating cooldowns | VERIFIED | Driven open by repeated failures; honoured by later routing |
| Shared retry budget across the chain | VERIFIED | Failover to a healthy provider inside the budget |
| Streaming fails over only before the first token | VERIFIED | A stall before any token fails over; the error names the whole chain |
| Stalled-stream detection | VERIFIED | Abandoned at the configured idle window rather than hanging |
| Inference pools | PARTIAL | 11 built-in pools; strategy override verified by unit tests, not end to end |
| Reservations and budgets | VERIFIED | Create, list and delete through the API; spend and use count written through to the database on every call, so a restart inside the window does not hand the reservation its budget back (`tests/unit/reservation-persistence.test.ts`) |
| Reservations under concurrent load | IMPLEMENTED_UNVERIFIED | The budget and concurrency ceilings are verified sequentially and across a restart; no reservation has been consumed by many callers at once |
| Credential scope precedence | VERIFIED | Unit tests cover the ordering and concurrency limits |
| Live model discovery, including removal | VERIFIED | Discovery registers a local server's models and replaces the set on each pass |

## Agent runtime

Covered in detail in [AGENT_VERIFICATION.md](AGENT_VERIFICATION.md).

| Capability | Status |
| --- | --- |
| Nine specialist agents | VERIFIED — all nine executed in a real pipeline via the kind that selects each (`tests/e2e/agent-roles.test.ts`), with an assertion that fails if a declared role has no pipeline driving it. `orchestrator` and `browser` were previously unreachable by any pipeline at all |
| Pipeline chosen from the request | VERIFIED |
| Tool loop with failures fed back to the model | VERIFIED |
| Twelve tools | VERIFIED — every tool in the registry is run through `executeTool` in `tests/unit/agent-tools.test.ts`, and the coverage assertion is derived from the registry so a new tool without a test fails. `web_fetch`'s success path against a public page remains BLOCKED_EXTERNAL; its refusal path is verified |
| Workspace containment | VERIFIED |
| Change review, diff, accept and reject | VERIFIED |
| Checkpoints and rewind | VERIFIED |
| Task forking | VERIFIED |
| Parallel lanes with conflict detection | VERIFIED |
| Cancellation | VERIFIED |
| Docker sandbox isolation | VERIFIED |
| Process sandbox, labelled as not a boundary | VERIFIED |
| Git operations, fixed command set, no push | VERIFIED |

## Security

Covered in detail in [SECURITY.md](SECURITY.md).

| Capability | Status | Evidence |
| --- | --- | --- |
| Path containment | VERIFIED | Eight escape shapes refused through the API; an agent instructed to escape gets a refusal |
| Command injection resistance | VERIFIED | A branch name carrying a shell command does not run it |
| SSRF: literal private addresses | VERIFIED | Loopback, link-local, RFC1918, CGNAT, IPv6, IPv4-mapped |
| SSRF: redirect hops | VERIFIED | A redirect into blocked space is refused and never requested |
| SSRF: names resolving into private space | VERIFIED | Refused at connect time, inside the DNS lookup |
| Credential encryption at rest | VERIFIED | AES-256-GCM under a scrypt-derived key; tampering and wrong-key cases covered |
| Credentials never returned | VERIFIED | Absent from four endpoints that could have leaked one |
| One user cannot read another's project files through the inference APIs | VERIFIED | Driven from the attacker's side across both dialects with a canary in the victim's project file; the workspace id in a request body is now checked against what the caller may reach (`tests/e2e/multi-user.test.ts`) |
| A task's file changes reach only its owner | VERIFIED | The diff event names its task so it can be attributed; an event that cannot be attributed goes to administrators rather than everyone (`tests/unit/event-audience.test.ts`) |
| Redaction in logs, audit and errors | VERIFIED | Including a secret a caller puts in a failing request |
| CSP without `unsafe-inline` on scripts | VERIFIED | Inline bootstrap allowed by hash; `object-src` and `base-uri` are `none` |
| Security headers on streamed responses | VERIFIED | Carried across the switch to the raw socket |
| Sandbox: no network | BLOCKED_EXTERNAL | Asserts no routes inside the container; `tests/e2e/docker-sandbox.test.ts` skips here — no Docker daemon |
| Sandbox: read-only root, workspace-only writes | BLOCKED_EXTERNAL | Same suite, same skip |
| Sandbox: environment built from scratch | BLOCKED_EXTERNAL | Asserts a canary in the gateway's environment does not reach the command; skipped here |
| Sandbox: timeouts and a pid ceiling | BLOCKED_EXTERNAL | Asserts a fork bomb leaves the daemon usable; skipped here |
| Sandbox misconfiguration detected at startup | VERIFIED | Mount probe catches both the path and the ownership case, without a daemon |
| Auth required mode | IMPLEMENTED_UNVERIFIED | Covered by integration tests; not exercised in the adversarial pass |

## Deployment

| Capability | Status | Evidence |
| --- | --- | --- |
| State survives a restart | VERIFIED | Workspaces, usage history and readiness after a full stop and a fresh App over the same directory |
| Migrations applied in order, the whole upgrade in one transaction | VERIFIED | 11 migrations; readiness reads the applied count (`tests/unit/migrations.test.ts`) |
| A previous release's database upgrades with its data intact | VERIFIED | A database built from the real migration files up to a cut-off, with rows written through them, opened by this build: the operator and their workspaces survive and the newest table exists |
| A failed migration fails closed | VERIFIED | A broken file stops startup, names itself, and leaves nothing behind — no partial schema, no `_migrations` row, and the same database upgrades cleanly once the file is removed |
| An older build refuses a newer database | VERIFIED | Startup refuses and names the migrations it does not recognise, before applying anything of its own — so a build that also has a migration the newer database lacks cannot write into a schema it does not understand |
| A release gate cannot excuse missing evidence | VERIFIED | A gate may only claim BLOCKED_EXTERNAL when the condition it names was observed on this run; a `blockedBy` naming a blocker nobody evaluates FAILS (`tests/unit/release-gates.test.ts`) |
| Shutdown can see work that has not started a task yet | VERIFIED | A parallel run is supervised from the moment it begins, so cancelling reaches it and shutdown waits for it (`tests/unit/parallel-shutdown.test.ts`) |
| Two processes starting at once | VERIFIED | Two real processes released from a barrier against a deliberately slow migration, three rounds: both start cleanly and the migration is recorded once |
| Discovery pacing survives a restart | VERIFIED | Backoff, the minimum interval and the consecutive-failure pause all reload; an operator's reset is not resurrected (`tests/unit/discovery-schedule-persistence.test.ts`) |
| Interrupted tasks are closed out | VERIFIED | Two separate assertions, so neither can stand in for the other: shutdown's own write is read straight from the database with no App in between (status `cancelled`), and boot reconciliation is checked on a database no process is attached to (status `failed`). Over a real App restart and a real 30-second provider call (`tests/e2e/task-interruption.test.ts`) |
| A task another live gateway is running is left alone | VERIFIED | A lease — owner and heartbeat — set by the ordinary run path; a second gateway booting against it changes nothing, and a ten-minute-stale lease is still closed out |
| Unstarted steps of an interrupted task are closed out | VERIFIED | Marked skipped rather than failed: they were never attempted |
| `docker compose config` valid | VERIFIED | — |
| `docker build` | BLOCKED_EXTERNAL | Base image blocked by this environment's egress policy |
| `docker compose up -d` | BLOCKED_EXTERNAL | Same |
| Sandbox image build | BLOCKED_EXTERNAL | No Docker daemon here at all. An earlier pass verified isolation against an image assembled from host binaries; this environment cannot repeat that |
| Health check in Compose | IMPLEMENTED_UNVERIFIED | Uses the liveness route; not run under Compose here |

## Web client and design system

Exercised in a real browser against a real gateway (`tests/ui/screens.test.ts`).
A React app that compiles is not one that runs: a screen can throw on first
paint, a CSP can block the bundle it was written for, and a layout can overflow
on a phone without anything failing to build.

| Capability | Status | Evidence |
| --- | --- | --- |
| All 21 screens render without a console error | VERIFIED | Each opened through the app's own navigation in Chromium, including the sixteen now behind the "Everything else" disclosure |
| The bundle loads under the app's own CSP | VERIFIED | A policy that blocked it would surface as a console error on first paint |
| Live data reaches the client | VERIFIED | The discovered model appears on the Models screen |
| Design tokens and three-state theming | VERIFIED | Both themes resolve a painted background and a distinct text colour; contrast ratios were computed, and four values corrected as a result |
| Responsive behaviour | VERIFIED | No horizontal overflow on any screen at 390, 834 and 1440 px |
| Sandbox posture stated in full | VERIFIED | The home card must contain "not a security boundary" as a complete sentence |
| Routing explanation panel | VERIFIED | Renders the requested mode and the applied policy when they differ |
| Checkpoint, rewind and fork controls | IMPLEMENTED_UNVERIFIED | Wired to verified endpoints; the controls are rendered but not driven |
| CodeMirror editor and xterm terminal | IMPLEMENTED_UNVERIFIED | Themed from the same tokens; not driven |
| Screenshots as artifacts | VERIFIED | `docs/evidence/screens/` is written on every run (git-ignored, since it changes every time) |

## Accounts, quota and the request trace (Phase 4)

Full write-up in [MERIDIAN_PHASE4_IMPLEMENTATION.md](MERIDIAN_PHASE4_IMPLEMENTATION.md).

| Capability | Status | Evidence |
| --- | --- | --- |
| An account fault stays on the account, not the provider | VERIFIED | Two users, one revoked key, a real socket: the provider's breaker stays closed and the other user is still served. The counterfactual is asserted in the same test |
| A service fault stays on the provider, not the account | VERIFIED | A 503 leaves the account's cooldown null and it stays available |
| An anonymous rate limit still blames the provider | VERIFIED | No credential, so there is no account to blame |
| Routing skips a cooling-down account and recovers | VERIFIED | Deterministic clock: the spare is chosen, then the primary returns by itself |
| A rejection distinguishes "busy" from "not configured" | VERIFIED | Asserted on the router's own rejection text |
| Rate-limit headers become an account allowance | VERIFIED | Against a real socket, and through the whole gateway with a real credential |
| Silence is never read as a full allowance | VERIFIED | A provider that publishes nothing records nothing |
| A spent window that has since reset stops applying | VERIFIED | Clock advanced past the reset |
| Account standing survives a restart | VERIFIED | A second `App` over the same directory returns state, cooldown and allowance |
| `health` credential-pool strategy | VERIFIED | Was a STUB identical to `priority`; now sorts by which key is working |
| Account standing on the API, CLI and UI | VERIFIED | `/api/credentials`, `uag accounts`, and the provider dialog; the reset route is owner-gated and exercised |
| A usage row names the agent step that produced it | VERIFIED | A real agent run: every row's step id matches a step in the task |
| A verification verdict lands on the step that earned it | VERIFIED | Store-level, asserting both halves — role matching returns two runs, step matching returns one |
| The routing decision survives the request | VERIFIED | The snapshot carries the applied mode, the requested mode and the winner |
| A request id can be traded for what happened | VERIFIED | `/api/trace/:id` returns every attempt and leads back to the task; an unknown id is a 404 |
| Trace scoping | VERIFIED | Non-admins see only their own rows, exactly as on `/api/usage` |
| Context savings recorded durably | VERIFIED | Written per attempt; null where nothing measured it, never zero |
| Trace on the CLI and the Usage screen | VERIFIED | `uag trace` against a running gateway; the panel driven in Chromium |
| Quota against a real provider's own headers | BLOCKED_EXTERNAL | No reachable provider publishes them without a credential |

## Model health (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| A retired model id does not take its provider offline | VERIFIED | Red-then-green against a real socket. `model_unavailable` is not retryable, so one 404 opened the provider's breaker and made every other model on it unroutable |
| The retired model is what leaves rotation | VERIFIED | The chain moves to a working model on the same provider; the dead id is on cooldown with a reason |
| A cooling-down model is not offered to the router | VERIFIED | Asserted on the router's own candidate list, so a call does not spend a request rediscovering the same 404 |
| A provider fault does not cool its models | VERIFIED | A 503 leaves every model available, or there would be nothing to fall back to when it recovers |
| A context overflow is a fact about the request, not the model | VERIFIED | Two overflows leave the model available |
| Models out of rotation are reported | VERIFIED | `/api/health` lists them with the reason; empty is the normal answer |

## Capability truth (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| Adapter surface reported as a ceiling, not as evidence | VERIFIED | `adapter.surface()`, `recordLiveContact`, `adapterSurface`; the old `verifiedCapabilities` field published method introspection under a name that promised a live call |
| `GET /api/capabilities` separates ceiling from evidence | VERIFIED | The sim executes chat and embeddings and not video; `text` reads `probe_verified` from a probe earlier in the same suite |
| No provider claims evidence for a modality it cannot execute | VERIFIED | Asserted across every provider in the matrix |
| An unspoken capability counts zero models rather than all of them | VERIFIED | Asserted on a capability nothing has claimed |
| The Matrix tab labels both halves | VERIFIED | Driven in Chromium |
| A capability probe is accounted for like any other call | VERIFIED | One usage row per probe through the same sink every completion uses, at the model's own rate card, against a real gateway and a real HTTP provider (`tests/e2e/probe-spend.test.ts`) |
| A probe refuses to spend without permission | VERIFIED | A metered model is skipped, with a reason, before any request is sent, when paid spend is not permitted |
| A probe run is bounded by a dollar ceiling | VERIFIED | Bound to what the run COMMITS, not what providers later report — a provider that omits its usage block cannot walk the counter past the cap (`tests/e2e/probe-spend.test.ts`) |
| A request cannot switch paid spending back on | VERIFIED | `MERIDIAN_ALLOW_PAID` is required as well as the request's own permission, as the router has always required both; a run may narrow, never widen |
| An unpriced model cannot pass the ceiling at $0.00 | VERIFIED | A card that can charge and publishes no rate is refused rather than priced at zero |
| Claim age discounts a stale claim in search as well as routing | VERIFIED | A two-year-old probe scores below a fresh one, says so in its reasons, and an undated catalogue entry is not treated as stale (`tests/unit/capability-evidence.test.ts`) |
| The router's "no fake support" guard | VERIFIED | Red-then-green. It asked only whether a method existed, and the OpenAI-compatible base defines every method and refuses at call time — so a chat-only endpoint was routed image work. The guard now asks the adapter's own surface too |

## Provider reachability (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| The Anthropic adapter reaches the real API | VERIFIED | Unauthenticated: a typed `authentication_failed`, and the probe key never survives into the error |
| The Google adapter reaches the real API | VERIFIED | Unauthenticated, and it found the defect below |
| Google's 400 `API_KEY_INVALID` classified as an auth failure | VERIFIED | Red against the live API before the fix; `invalid_request` meant no failover and no account cooldown |
| A real provider's auth failure lands on the account | VERIFIED | Provider breaker still closed afterwards |
| Any authenticated call to a hosted provider | BLOCKED_EXTERNAL | No credential exists here, and fabricating one is out of bounds |
| The other nine hosted adapters | BLOCKED_EXTERNAL | Refused at CONNECT by the egress policy — OpenAI, Groq, OpenRouter, Mistral, DeepSeek, Together, Cohere, HuggingFace, Cloudflare, Replicate, fal, Pollinations, AI Horde |

## Test harness honesty (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| The browser suite tests the sources, not a stale bundle | VERIFIED | Found by a test written for markup the bundle did not contain; the suite now rebuilds when `apps/web/src` or `packages/ui/src` is newer than `dist/web` |
| MCP tools reach a real model in a real run | VERIFIED | A dependency-free MCP server in the repository, assigned to a workspace; the model's call is answered by the server and recorded in the task |

## CLI

Exercised as a real process against a running gateway
(`tests/e2e/cli.test.ts`), because that is where a CLI actually breaks — an
unset base URL, a response shape it did not expect, an argument parsed
differently from the way the help text describes.

| Capability | Status | Evidence |
| --- | --- | --- |
| `status` | VERIFIED | Reports the instance, its counts and its sandbox posture |
| `models`, `providers`, `pools` | VERIFIED | Live data; local models shown as LOCAL, uncredentialed providers as `not_configured` |
| `chat` | VERIFIED | Real completion with token count and cost |
| `code` | VERIFIED | Runs the pipeline and names the files it changed; the file exists on disk afterwards |
| `compare` | VERIFIED | Refuses a missing option with the correct usage rather than failing silently |
| `help` | VERIFIED | Names every command that is implemented |
| `trace` | VERIFIED | Run against a live gateway: prints every attempt and the applied routing policy, and reports an unknown id as not found rather than as an empty trace |
| `accounts` | VERIFIED | Run against a live gateway: an allowance nobody published reads "not published", never a number |
| `task`, `usage`, `configure`, `benchmark`, `research`, `image`, `video`, `audio` | IMPLEMENTED_UNVERIFIED | Real implementations; not exercised in this pass |
