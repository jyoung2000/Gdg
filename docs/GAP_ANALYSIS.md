# Gap analysis

What the second pass found, what was closed, and what remains open.

The first pass produced a complete-looking system with 143 passing tests. The
question this pass asked was not "does it look right" but "what happens when it
is actually run" — against a real inference server over a real socket, against
real containers, and against an attacker's requests rather than a developer's.

Nine defects surfaced that way. Six of them could not have been found by reading
the code, and two would have made a headline feature silently useless in the
shipped configuration.

## Closed in this pass

### 1. Docker sandboxing could not have worked as shipped — CLOSED

**Severity: critical.** Two independent defects, either one fatal.

*Path translation.* `DockerSandbox` passed its own working directory to
`docker run -v`. The daemon resolves that against the **host** filesystem, not
the caller's. A containerised gateway — which is how the shipped Compose stack
runs it — asked for `-v /workspaces/ws_x:/work`, a path that does not exist on
the host. Docker creates it, empty, and mounts that. Every agent command would
have run against an empty directory and reported success.

*User mismatch.* The gateway image runs as uid 1001 and the sandbox image as
1002. Even with correct paths, a sandboxed command could read the workspace and
never write to it: every `npm install`, build or commit would have failed with a
permission error that looks like a bug in the command.

**Reproduced:** by running the product's own `DockerSandbox` against a real
container and watching `cat input.txt` return nothing and `touch` return
`Permission denied`.

**Closed by:** `MERIDIAN_WORKSPACE_HOST_ROOT` and path translation; running each
container as the gateway's own uid and gid; and a startup probe that writes a
file, reads it back from inside a container and writes one back out, so both
failures are caught at boot with a message naming the setting to change instead
of being discovered through commands that quietly do nothing.

**Verified by:** `tests/e2e/docker-sandbox.test.ts` (10 tests).

### 2. SSRF: redirects were not re-checked — CLOSED

**Severity: high.** `web_fetch` checked the hostname of the URL the model
supplied, then called `fetch` with `redirect: 'follow'`. A public URL answering
`302 http://169.254.169.254/latest/meta-data/` was followed without a second
check. The guard only ever saw the harmless first hop.

**Closed by:** following redirects one at a time, re-checking every hop, to a
depth of five.

### 3. SSRF: names resolving into private space — CLOSED

**Severity: high.** A hostname is not a literal IP, so a textual check passed
`db.internal.example.com` pointing at `10.0.0.5`.

**Closed by:** running the guard inside the DNS lookup, on every address a name
resolves to, at the moment the socket is about to connect. That also closes most
of the rebinding window, because there is no second resolution between check and
connect. `docs/SECURITY.md` states the residual risk rather than implying there
is none.

### 4. Endpoint variables were read as credentials — CLOSED

**Severity: medium.** Four local-server providers listed `OLLAMA_HOST`,
`VLLM_BASE_URL`, `LLAMACPP_BASE_URL` and `LMSTUDIO_BASE_URL` in `envKeys`, which
is the list of *credentials*. Automatic discovery read each URL as a secret,
sealed it, showed it in the UI as a credential, and would have sent it as that
provider's API key. The override itself was never implemented, so setting one
moved nothing.

**Closed by:** a separate `baseUrlEnvKeys` field that does what it says — parsed
before use, accepting `OLLAMA_HOST`'s bare `host:port` convention, ignoring a
malformed value rather than failing later.

### 5. Error responses echoed secrets — CLOSED

**Severity: medium.** A request naming a nonexistent model had its own input
quoted back verbatim. A caller who pasted a key into the wrong field got it
returned into their console and their logs.

**Closed by:** redacting error responses on the way out.

### 6. One body limit for every route — CLOSED

**Severity: medium.** The 32 MB ceiling exists so vision and audio requests can
carry their payloads. It applied to every admin and workspace route too, so any
of them could be used to push tens of megabytes into memory.

**Closed by:** a 2 MB default, raised only on the media-carrying routes.

### 7. Streamed responses lost their security headers — CLOSED

**Severity: medium.** Streaming writes to the raw socket, which bypasses
Fastify's header handling, so SSE responses went out without the CSP, `nosniff`
or request id that every buffered response carries.

**Closed by:** one `beginSse` helper that carries them over, used by all three
streaming routes.

### 8. A streamed error reported only the last failure — CLOSED

**Severity: low, but misleading.** A stalled stream that fell through to a
rate-limited alternate was reported as a rate limit, sending the operator after
the wrong problem.

**Closed by:** naming the whole chain, matching what the non-streaming path
already did.

### 9. `IPv4-mapped IPv6` bypassed the private-address check — CLOSED

**Severity: low.** `::ffff:169.254.169.254` reaches the same host as the bare
IPv4 address but was not judged as one.

## Missing capabilities that were built

| Gap | Status |
| --- | --- |
| No readiness endpoint — a container platform could not tell a started gateway from a usable one | CLOSED: `/api/system/ready`, 503 with per-check detail |
| No first-run guidance | CLOSED: `/api/onboarding`, derived from live state rather than a stored flag |
| No idempotency — a client retrying after a timeout was charged twice or started a second agent task | CLOSED: `Idempotency-Key`, with the insert as the lock |
| Stream idle timeout hardcoded at 90s | CLOSED: `MERIDIAN_STREAM_IDLE_TIMEOUT_MS` |
| No way to undo one step of an agent run | CLOSED: checkpoints and rewind |
| No way to try a different approach without destroying the first | CLOSED: task forking |
| `pnpm test:e2e` named a suite the runner did not define, so it had never run | CLOSED |
| The routing explanation reported the applied policy, not the mode the user chose | CLOSED: both are reported |
| Seven credential and endpoint variables were read but undocumented | CLOSED |

## Open, and why

### BLOCKED_EXTERNAL

| Gap | Why it cannot be closed here |
| --- | --- |
| No provider has been exercised against its real API | No credential is present, and most provider hosts are unreachable under this environment's egress policy. `pnpm test:live` exists to close this the moment a key is available |
| `docker build` and `docker compose up -d` | Base images come from Docker Hub, whose blob CDN answers 403 under this environment's egress policy. Reported, not routed around — see `docs/evidence/DOCKER.md` |
| Image, video, speech and transcription generation | Each needs a credentialed provider that serves it |
| `web_fetch`'s success path against a real page | Outbound HTTP is filtered here; the refusal paths are verified |

### IMPLEMENTED_UNVERIFIED — real code, no end-to-end evidence

| Area | What is missing |
| --- | --- |
| Three of nine agents (orchestrator, researcher, debugger) | The pipelines exercised here did not select them. They share the verified loop, tools and routing; their own instruction and sequencing are untested |
| WebSocket event transport | SSE is verified; the WebSocket alternative is not |
| Reservations under load | Create, list and delete are verified through the API; no reservation was consumed by concurrent traffic |
| Rate limiting at its limit | The bucket and sweeper exist; nothing here drove them to 429 |
| Auth-required mode adversarially | Covered by integration tests, not by the adversarial pass |
| Eight of fifteen CLI commands | Seven are verified end to end; the rest have real implementations and no test |
| Web client screens | Rendered and navigated manually in the first pass; no automated UI test |
| Media asset writing and cancellation | The engine is wired end to end; no generation has produced an asset here |

### Deliberately not built

| Not built | Why |
| --- | --- |
| A headless browser for the Browser agent | `web_fetch` is an HTTP fetch and says so, in its description, its system prompt and the docs. Shipping a browser would add a large attack surface and a heavy dependency to a tool whose honest limits are already stated |
| Automatic credential discovery beyond documented environment variables | The product's own constraint. Nothing reads browser storage, other applications' config, cloud metadata or repositories |
| Pushing to a remote from an agent | The git tool and the git route both refuse. An agent may commit locally; publishing is the user's decision |
| Automatic merging of parallel lanes | Conflicts are detected and reported; resolving them is the user's call |

## What would move this to a live-verified state

In priority order:

1. One provider credential (`GROQ_API_KEY` or `OPENROUTER_API_KEY` are free to
   obtain) and `pnpm test:live`. That converts the whole provider matrix from
   IMPLEMENTED_UNVERIFIED to measured.
2. Registry access, then `pnpm sandbox:image && docker compose up -d`, which
   converts the deployment gate from PARTIAL to VERIFIED.
3. An image-capable and a speech-capable credential, which converts the media
   modalities.
4. Automated UI tests over the eleven screens.
