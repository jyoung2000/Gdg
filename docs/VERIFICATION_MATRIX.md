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
| Reservations and budgets | IMPLEMENTED_UNVERIFIED | Create, list and delete verified through the API; no reservation was consumed under load |
| Credential scope precedence | VERIFIED | Unit tests cover the ordering and concurrency limits |
| Live model discovery, including removal | VERIFIED | Discovery registers a local server's models and replaces the set on each pass |

## Agent runtime

Covered in detail in [AGENT_VERIFICATION.md](AGENT_VERIFICATION.md).

| Capability | Status |
| --- | --- |
| Nine specialist agents | PARTIAL — six exercised in a real pipeline, three not |
| Pipeline chosen from the request | VERIFIED |
| Tool loop with failures fed back to the model | VERIFIED |
| Eleven tools | PARTIAL — nine exercised; `delete_file` and `web_fetch`'s success path are not |
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
| Redaction in logs, audit and errors | VERIFIED | Including a secret a caller puts in a failing request |
| CSP without `unsafe-inline` on scripts | VERIFIED | Inline bootstrap allowed by hash; `object-src` and `base-uri` are `none` |
| Security headers on streamed responses | VERIFIED | Carried across the switch to the raw socket |
| Sandbox: no network | VERIFIED | No routes inside the container |
| Sandbox: read-only root, workspace-only writes | VERIFIED | — |
| Sandbox: environment built from scratch | VERIFIED | A canary in the gateway's environment does not reach the command |
| Sandbox: timeouts and a pid ceiling | VERIFIED | A fork bomb leaves the daemon usable |
| Sandbox misconfiguration detected at startup | VERIFIED | Mount probe catches both the path and the ownership case |
| Auth required mode | IMPLEMENTED_UNVERIFIED | Covered by integration tests; not exercised in the adversarial pass |

## Deployment

| Capability | Status | Evidence |
| --- | --- | --- |
| State survives a restart | VERIFIED | Workspaces, usage history and readiness after a full stop and a fresh App over the same directory |
| Migrations applied in order, each in one transaction | VERIFIED | Three migrations; readiness reads the applied count |
| `docker compose config` valid | VERIFIED | — |
| `docker build` | BLOCKED_EXTERNAL | Base image blocked by this environment's egress policy |
| `docker compose up -d` | BLOCKED_EXTERNAL | Same |
| Sandbox image build | PARTIAL | The real image is BLOCKED_EXTERNAL; a verification-only image was assembled from host binaries and used to verify isolation |
| Health check in Compose | IMPLEMENTED_UNVERIFIED | Uses the liveness route; not run under Compose here |

## Web client and design system

| Capability | Status | Evidence |
| --- | --- | --- |
| Eleven screens | IMPLEMENTED_UNVERIFIED | Rendered and navigated manually; no automated UI test |
| Design tokens and three-state theming | VERIFIED | Contrast ratios computed rather than asserted; four values were corrected as a result |
| Responsive behaviour | PARTIAL | Verified by a headless sweep at three viewports during the first pass; not automated |
| Routing explanation panel | VERIFIED | Renders the requested mode and the applied policy when they differ |
| Checkpoint, rewind and fork controls | IMPLEMENTED_UNVERIFIED | Wired to verified endpoints; the controls themselves are not automated |
| CodeMirror editor and xterm terminal | IMPLEMENTED_UNVERIFIED | Themed from the same tokens; not automated |

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
| `task`, `usage`, `configure`, `benchmark`, `research`, `image`, `video`, `audio` | IMPLEMENTED_UNVERIFIED | Real implementations; not exercised in this pass |
