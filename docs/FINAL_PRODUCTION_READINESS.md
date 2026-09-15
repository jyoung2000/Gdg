# Meridian — final production readiness

Every figure here comes from a run. `pnpm verify:production` regenerates this
report's inputs: `docs/evidence/RELEASE.md` for people, `release-readiness.json`
for pipelines. Where the two disagree with this page, they are right and this
page is stale.

Version: **1.0.0-rc.1** · Branch: `claude/universal-ai-gateway-0hosgu`

---

## 1. Executive summary

### RELEASE CANDIDATE

Not "production ready", and the reason is specific rather than cautious.

**819 tests, 808 passing, 11 skipped, 0 failing.** Six of nine release gates
pass. Every gate that this environment is capable of running has run and passed.

Three things stand between this and production, and none of them is a code
defect:

1. **No hosted provider has completed an authenticated request.** Two adapters
   (Anthropic, Google) have reached their real endpoints unauthenticated, which
   found and fixed a misclassification that would have suppressed failover.
   Everything past authentication is unverified. A universal AI gateway whose
   provider integrations have never completed a real call is not production
   ready, however good its internals look.
2. **Docker has never been built or run here.** No daemon, and the registry is
   refused by the egress policy. That covers the deployment gate *and* the
   container-sandbox gate.
3. **The Windows installer has never been built or installed.** No Windows
   runner.

Each is an environment limitation with a command ready to run where the
dependency exists — see `docs/RELEASE_CHECKLIST.md` §6–§8. None requires a code
change.

---

## 2. Repository changes in this pass

| Area | Change |
| --- | --- |
| Budget correctness | `AIRequest.billableUnits`: an `n: 8` image request now reserves eight images and a 30-second clip reserves thirty seconds. Both estimates hard-coded one unit, so a multi-output request cleared a budget it then blew through |
| Shutdown | Background work is tracked and drained on shutdown. Every periodic task ran as `void fn()`, so the store closed underneath a discovery pass mid-write, losing the backoff row that stops the next boot hammering a provider that had just rate-limited us |
| Capability UI | The Verify button sends `allowPaid` and renders the gateway's `skipped` reason. It did neither, so a refusal-for-cost rendered as "0 capabilities verified" — a money decision shown as a capability finding |
| Version semantics | `1.0.0` → `1.0.0-rc.1` across every manifest, the Rust crate and `MERIDIAN_VERSION`. The Tauri bundle keeps the base version because an MSI cannot encode a prerelease suffix; the gate knows this and says so rather than letting it drift |
| Release tooling | `pnpm verify:production` (lint + the full release pass) now emits `release-readiness.json` from what actually ran. Test counts, skips and blockers are derived, not asserted |

Earlier in the same branch: probe spend accounting and its two refusals, the
stale-claim discount in capability search, discovery pacing persistence,
reservation persistence, interrupted-task reconciliation with a live-gateway
lease, four upgrade-path guarantees, and eleven defects found by an adversarial
audit of this branch's own diff.

---

## 3. Capability matrix

Detail lives in [VERIFICATION_MATRIX.md](VERIFICATION_MATRIX.md),
[PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md),
[AGENT_VERIFICATION.md](AGENT_VERIFICATION.md) and
[MODALITY_VERIFICATION.md](MODALITY_VERIFICATION.md) — 224 claims, counted by
`node scripts/scorecard.mjs`: **160 VERIFIED, 25 IMPLEMENTED_UNVERIFIED, 4
PARTIAL, 35 BLOCKED_EXTERNAL, 0 MISSING, 0 STUB, 0 FAILED.**

| Capability | Status | Evidence | Remaining blocker |
| --- | --- | --- | --- |
| OpenAI-compatible chat, streaming, tools, embeddings | VERIFIED | E2E against a real inference server over a socket | — |
| Anthropic Messages, streaming, tool use | VERIFIED | Gate `claude-code`, 4 tests | — |
| Router: eligibility, ranking, 15 modes | VERIFIED | Invariants over hundreds of generated registries | — |
| Fallback, circuit breakers, retry budget | VERIFIED | Gate `fallback`, 3 tests | — |
| Budget: pools, reservations, multi-output | VERIFIED | Chaos suite + `tests/router/multi-output-budget.test.ts` | Concurrent consumption of one reservation still unverified |
| Unknown price never treated as free | VERIFIED | `tests/router/cost-honesty.test.ts` | — |
| Credential isolation, SSRF, redaction | VERIFIED | Gate `security`, 8 tests, driven from the attacker's side | — |
| Persistence, migrations, upgrade path | VERIFIED | `tests/unit/migrations.test.ts`, incl. a real previous-release database | One version step, not a fleet |
| Agent runtime (9 roles) | PARTIAL | 6 of 9 exercised in a real pipeline; all 9 checked for definition and selectability | orchestrator, researcher, debugger unexercised |
| MCP | VERIFIED | A dependency-free MCP server in-repo, assigned to a workspace, tool call answered and recorded | — |
| Browser + SSRF refusal | VERIFIED | Real public fetch plus refusal of loopback/RFC1918/metadata, at every redirect | — |
| Web client, 21 screens | VERIFIED | Real Chromium, 3 viewports, both themes | — |
| Token/context optimization | IMPLEMENTED_UNVERIFIED | Wired into agent flows; before/after metrics exist | Not yet measured on ordinary gateway chat |
| Multimodal | PARTIAL | Refusal paths and embeddings verified; success paths are code-tested only | Needs a credentialed provider |
| Windows desktop | IMPLEMENTED_UNVERIFIED | Payload verifier checks every migration ships; signing configured | Needs a Windows runner |
| Docker deployment + sandbox | BLOCKED_EXTERNAL | Compose config validated | Needs a daemon and registry |

---

## 4. Tests

| | Count |
| --- | ---: |
| Total | 819 |
| Passed | 808 |
| Failed | 0 |
| Skipped | 11 |
| Externally blocked (gates/steps) | 4 |

All 11 skips are the container-sandbox and Docker suites, each naming the
missing daemon. 75 test files across unit, router, contract, integration, e2e,
ui and chaos.

---

## 5. Provider verification

24 providers in the catalogue: openrouter, groq, cerebras, sambanova, together,
fireworks, hyperbolic, nvidia, anthropic, openai, google, deepseek, mistral,
xai, pollinations, ai-horde, huggingface, cloudflare, fal, replicate, ollama,
vllm, llamacpp, lmstudio.

| Provider | Status |
| --- | --- |
| anthropic, google | **ADAPTER VERIFIED + UNAUTHENTICATED REACHABILITY** — real endpoint reached; a typed `authentication_failed` returned, probe key never leaked into the error. Google's 400 `API_KEY_INVALID` was being classified as `invalid_request`, which suppressed failover and account cooldown; found by this test and fixed |
| All 22 others | **ADAPTER VERIFIED** — request/response mapping, streaming, tool-call reassembly and error classification covered by contract tests against deterministic fixtures |
| All 24 | **AUTHENTICATED: EXTERNAL BLOCKER** — no credential exists in this environment |
| ollama, vllm, llamacpp, lmstudio | **EXTERNAL BLOCKER** — no local inference server running here. Discovery and health-check code paths are tested against the in-repo simulator |

No provider is marked authenticated-verified. Run `pnpm test:live` with
credentials to convert these.

---

## 6. Multimodal verification

| Modality | Status | Evidence |
| --- | --- | --- |
| Vision | ADAPTER VERIFIED | Image carried through both surfaces unaltered; routing to vision-capable models; refusal when none available |
| Image generation | ADAPTER VERIFIED | Request mapping, multi-output budget reservation, cancellation, asset persistence. Success path needs a provider |
| Video | ADAPTER VERIFIED | Duration-scaled reservation, polling, long timeout. Success path needs a provider |
| Speech | ADAPTER VERIFIED | Request mapping and asset handling |
| Transcription | ADAPTER VERIFIED | Request mapping |
| Embeddings | **VERIFIED** | Real vectors through the gateway, consistent width, batch order preserved |

Only embeddings has an authenticated success path here, because only it has a
provider that works without a credential.

---

## 7. Docker

**EXTERNAL BLOCKER — no Docker daemon.**

`docker info` fails in this environment, and the registry is refused by the
egress policy, so neither `docker compose build` nor `docker compose up` has
run. `docker-compose.yml` is config-validated. The container-sandbox suite
skips, loudly, naming the daemon.

The release script observes this rather than assuming it: a gate may only claim
BLOCKED_EXTERNAL when the condition it names was actually seen on that run.
Commands to run where a daemon exists: `docs/RELEASE_CHECKLIST.md` §6.

---

## 8. Windows

**EXTERNAL BLOCKER — no Windows runner.**

The installer has not been built or installed. What *is* verified here:
`scripts/verify-desktop-payload.mjs` asserts the payload carries the Node
runtime, the server bundle, the web root, the native `better-sqlite3` binary and
**every** migration — counted against the repository, so a payload one migration
short fails rather than shipping. `.github/workflows/windows-desktop.yml` builds
and uploads the installer on a Windows runner.

Signing is configured and **unsigned** without a certificate. The binary this
repository would produce today is unsigned; it is not described otherwise
anywhere.

---

## 9. Security

Tests performed, all from the attacker's side:

- **Cross-user isolation** — credentials, workspaces, tasks, usage, files,
  traces and events, each attempted as the wrong user.
- **Project-file exfiltration** — a workspace id in a chat request body was
  never checked against what the caller may reach, on all three inference
  dialects. Fixed; regression test drives it with a canary in the victim's file.
- **Event bus** — a task's file diffs were broadcast to every connected client.
  Fixed; an event that cannot be attributed now goes to administrators, not
  everyone.
- **Paid-spend kill switch** — one request could switch `MERIDIAN_ALLOW_PAID`
  back on for the deployment. Fixed; instance and request are now both required.
- **SSRF** — loopback, RFC1918, link-local, CGNAT, IPv6, IPv4-mapped, names
  resolving into private space, and redirect hops, refused at connect time.
- **Credentials** — AES-256-GCM at rest under a scrypt-derived key; absent from
  four endpoints that could have leaked one; redacted in logs, audit and errors,
  including a secret a caller puts in a failing request.
- **Headers and limits** — CSP without `unsafe-inline` on scripts, security
  headers carried across the switch to the raw socket for streamed responses,
  per-route body limits, rate limiting on every route that spends.

Every fix above carries a regression test, and each was mutation-verified: the
fix removed, the test watched to fail, then restored.

---

## 10. Load and concurrency

The chaos suite (19 tests) runs concurrent callers against shared state:

- **Budget** — 40 workers against one pool budget; accepted spend never exceeds
  the configured ceiling. Verified decisive by running it against a mutated
  build where the in-flight hold was removed: $0.72 spent against a $0.09 cap.
- **Credentials** — concurrent acquisition against per-credential concurrency
  limits.
- **Rate limiting** — concurrent requests against the gateway's limiter.
- **Two gateways, one database** — real processes released from a barrier
  against a deliberately slow migration, three rounds.

Not done: an extended soak. Leak, file-descriptor and memory-growth behaviour
over hours is unmeasured.

---

## 11. Known limitations

- Three of nine agent roles (orchestrator, researcher, debugger) are selectable
  and defined but have not run in a real pipeline.
- Context optimization is integrated with agent flows; ordinary gateway chat is
  not yet measured before/after.
- Reservations are verified sequentially and across a restart, not under
  concurrent consumption.
- The upgrade test is a single version step.
- Backup/restore is a documented drill, not an automated test. It is reported as
  `manual-procedure-documented`, not as verified.
- No soak test.
- `agent-s` and `ui-tars` computer backends are detected, not implemented; they
  refuse with a typed error and a remediation rather than pretending.

---

## 12. External blockers

| Blocker | Blocks | Unblocked by |
| --- | --- | --- |
| No provider credentials | Authenticated provider verification; multimodal success paths | One API key + `pnpm test:live` |
| No Docker daemon | Deployment gate, container-sandbox gate | A machine with Docker |
| No registry egress | `docker build`, the real sandbox image | Network policy allowing the base image |
| No Windows runner | Installer build and install test | The existing GitHub Actions workflow |
| No code-signing certificate | A signed installer | A certificate in CI secrets |

---

## 13. Production verdict

**Can Meridian safely be released to ordinary users today?**

**No** — and the reason is narrow. Nothing known to be broken is shipping. The
problem is what has never been proven: no hosted provider has completed an
authenticated request, no container has been built or run, and no installer has
been installed. For a product whose entire job is brokering calls to hosted
providers, that is the gap that matters.

For a *local, single-user* install driving local models, the evidence is much
stronger — but that is not what a 1.0 claims.

**What remains before Meridian 1.0:**

1. One provider credential, `pnpm test:live`, and a real multimodal call. This
   is the highest-value action available and converts the most rows.
2. Docker build + compose up + restart-persistence, then the real sandbox image
   and the container-isolation suite with `MERIDIAN_SANDBOX=docker`.
3. Windows installer built and installed on a clean machine; upgrade and
   uninstall exercised.
4. The three unexercised agent roles driven end to end.
5. One backup/restore drill performed and recorded.
6. A soak run long enough to show whether anything leaks.

Promote `1.0.0-rc.1` to `1.0.0` when 1–3 have been run somewhere capable of
running them, and recorded.
