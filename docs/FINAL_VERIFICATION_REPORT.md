# Final verification report

What the evidence supports about Meridian, stated at the level the evidence
actually reaches.

Every number below comes from a run. The scorecard is derived from the four
verification matrices by `node scripts/scorecard.mjs`; the gates and the suite
counts come from `docs/evidence/RELEASE.md`, which `pnpm verify:release` writes
from a pass rather than from a claim. Regenerate both before trusting this file
after a change.

---

## Release classification

### BETA

Meridian is a real, working product, and the case for that is mechanical rather
than rhetorical: **813 tests, 802 passing, 11 skipped, none failing.** All
eleven skips are the container-sandbox and Docker suites, which name the
missing Docker daemon as their reason and are not counted as passing anywhere.
The provider-credential gap does not appear as a skip: those rows are
BLOCKED_EXTERNAL in the matrices instead.

What passes includes 138 end-to-end tests that cross a socket and a process
boundary into a real inference server, 30 that drive the web client in a real
browser across three viewports and both themes (three more check the offline
artefact rather than the app), 19 chaos tests that attack the running gateway
concurrently, and 24 contract-and-invariant tests, of which the router
invariants hold across hundreds of generated registries. The autonomous coding pipeline writes files that exist
on disk afterwards. State survives a restart, and — since this pass — so do
discovery backoff, reservation spend, and the truth about tasks that were
running when the process died.

It is not a release candidate, and the reason has not changed: **not one of its
hosted providers has been exercised against its real API with a credential.**
Two adapters — Anthropic and Google — have reached their real endpoints
unauthenticated, which found and fixed a misclassification that would have
suppressed failover. Everything past authentication is unverified. A universal
AI gateway whose provider integrations have never completed a real request is
not a release candidate, however good its internals look, and saying otherwise
would be exactly the rounding-up this report exists to prevent.

What separates BETA from RELEASE CANDIDATE is external, not architectural:

1. One provider credential and a `pnpm test:live` run.
2. Registry access, then `docker compose up -d` and `docker build` against the
   real images.
3. An image- and a speech-capable credential for the media modalities.

None of the three requires a code change. All three are blocked by this
environment, not by the product.

### Why not the neighbouring classifications

**Not PROTOTYPE or ALPHA.** See the numbers above. "Does it work at all" has not
been the open question for a long time.

**Not RELEASE CANDIDATE.** No authenticated provider call, no verified container
build or deployment, and 25 claims still IMPLEMENTED_UNVERIFIED — real,
reviewed code that nothing exercised end to end here. A release candidate should
not have that much of its surface in that state.

**Not PRODUCTION READY.** No live provider, no verified container deployment, no
production soak, no load testing. The upgrade path is now tested — a previous
release's database, carried forward with its data — but a single version step in
a test is not the same as a fleet upgrading.

---

## Feature scorecard

Counted across [VERIFICATION_MATRIX.md](VERIFICATION_MATRIX.md),
[PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md),
[AGENT_VERIFICATION.md](AGENT_VERIFICATION.md) and
[MODALITY_VERIFICATION.md](MODALITY_VERIFICATION.md), each of which lists its
rows' evidence. Regenerate with `node scripts/scorecard.mjs --write`.

<!-- scorecard:start -->
| Status | Count | Share |
| --- | ---: | ---: |
| VERIFIED | 160 | 71% |
| IMPLEMENTED_UNVERIFIED | 25 | 11% |
| PARTIAL | 4 | 2% |
| BLOCKED_EXTERNAL | 35 | 16% |
| MISSING | 0 | — |
| STUB | 0 | — |
| FAILED | 0 | — |

224 claims across the four matrices, counted by `node scripts/scorecard.mjs`.
<!-- scorecard:end -->

The BLOCKED_EXTERNAL share is high because the provider matrix contributes
twenty rows of it: twenty remote providers, none credentialed here. That single
fact is what holds the classification at BETA.

No capability is MISSING, STUB or FAILED, and `node scripts/scorecard.mjs`
exits non-zero if one ever is — the gate runs in CI and in
`pnpm verify:release`, so this is a check rather than an assertion.

### By area

| Area | Verdict |
| --- | --- |
| Routing | VERIFIED — including the guarantees, as invariants over hundreds of generated registries |
| OpenAI-compatible API | VERIFIED for text, streaming, tools, embeddings, model listing |
| Anthropic-compatible API | VERIFIED for text, streaming, tool use |
| Agent runtime | VERIFIED — six of nine agents exercised in a real pipeline; the runtime around all nine is |
| Sandbox | Process isolation VERIFIED; container isolation BLOCKED_EXTERNAL in this environment |
| Security | VERIFIED — including multi-user isolation, SSRF, redaction and the event bus |
| Persistence and upgrade | VERIFIED — a full restart, and a previous release's database carried forward |
| Provider integrations | IMPLEMENTED_UNVERIFIED / BLOCKED_EXTERNAL — the contract is enforced mechanically; no authenticated request has completed |
| Media generation | IMPLEMENTED_UNVERIFIED — the refusal path is verified, the success path needs a provider |
| Web client | VERIFIED — every screen in a real browser, three viewports, both themes, live data |
| CLI | PARTIAL — some commands verified end to end, others not |
| Docker deployment | BLOCKED_EXTERNAL — no daemon and no registry access here |

---

## Release gates

From `docs/evidence/RELEASE.md`, regenerated on every `pnpm verify:release`.
This table is copied from that file; if the two disagree, that file is right.

| Gate | Status |
| --- | --- |
| Core routing | VERIFIED |
| Anthropic-compatible surface, end to end | VERIFIED |
| Autonomous coding pipeline | VERIFIED |
| Fallback and resilience | VERIFIED |
| Web client | VERIFIED |
| Security | VERIFIED |
| Deployment: persistence and container configuration | BLOCKED_EXTERNAL |
| Sandbox isolation | BLOCKED_EXTERNAL |
| Multimodal surfaces | PARTIAL |

Six VERIFIED. Two could not run here at all, and are reported as
BLOCKED_EXTERNAL rather than as passes: `docker build` and `docker compose up`
need base images from a registry this environment's egress policy refuses, and
container isolation needs a daemon it does not have. The process-sandbox
fallback and its degraded-mode warning *are* verified. The PARTIAL gate is
multimodal: the refusal paths are covered, the success paths need a
credentialed provider.

---

## What this pass changed

106 files, +6,885 / −553, across 23 commits. The previous report described a
product at 237 tests; it is now at 813.

| Commit | What it closed |
| --- | --- |
| Close the pool-budget double-spend window | Concurrent callers could each pass a budget check before any of them recorded a spend. The reservation is now taken before the call, sized from the caller's own output ceiling |
| Stop a busy credential from being reported as a broken one | A key at its concurrency limit was reported as absent, sending operators to re-enter a credential that was working |
| Close five ways the gateway told the wrong person something | Event-bus leakage across users, secrets reachable in streamed errors, two admin routes missing a scope check, a browser policy one caller could widen for everyone |
| Stop a probe writing down what it did not learn | A model refusing an optional parameter was read as a model refusing the capability, deleting a capability it had |
| Give the release gates something to fail on | Version drift, vulnerable dependencies and a stale scorecard could all ship; now each is a gate |
| Let a reviewer route away from the model that wrote the code | A reviewer and the implementer could be the same model, marking its own homework |
| Make the offline artefacts regenerable in one command | The mockup and its previews were hand-driven and drifted; `pnpm mockup` now builds, captures and shoots from the running app, and a gate refuses a stale one |
| Account for capability-probe spend | Probes called providers outside the router, the pools and the usage ledger. They now refuse to spend without permission, stop at a dollar ceiling, and record every probe as usage |
| Apply the stale-claim discount in search | Routing discounted an old claim and search did not, so the answer on screen disagreed with the model routing actually chose |
| Persist discovery pacing | Backoff and the failure pause lived in a Map. A restart — most likely exactly when a provider is failing — cleared both and queried it again immediately |
| Make a restart honest about reservations and tasks | A reservation's budget reset to zero on restart; tasks abandoned by shutdown stayed "running" forever |
| Make upgrades survivable | The whole upgrade is now one transaction, two processes starting together no longer crash one of them, and an older build refuses a newer database instead of corrupting it quietly |

An adversarial audit was then run over this pass's own diff — eight
dimensions, each finding verified by three independent skeptics prompted to
refute it. It found eleven real defects in work this pass had just added,
including two the pass had introduced while closing something else:

| Found | What it was |
| --- | --- |
| The probe ceiling priced an unpublished rate card at $0.00 | `computeCost` adds a term per *published* rate, so a metered model with none priced at zero and passed any ceiling, any number of times, while the ledger recorded $0.00 |
| The probe ceiling counted measured spend | A provider that omits its usage block reports nothing, so the counter never moved however many models followed |
| A request could switch paid spending back on | `req.allowPaid ?? instance` let one call spend on a deployment whose operator had switched spending off |
| One user could read another's project files | The workspace id in a chat request was never checked against what the caller may reach, on all three dialects |
| Task diffs went to every connected client | The event named no task, so attribution returned "nobody", which this bus reads as everybody |
| Boot reconciliation failed a second live gateway's tasks | The same pass that made two gateways supportable also made one of them destroy the other's work |
| An older build wrote into a newer database before refusing it | The refusal ran after the migration pass rather than before |
| Shutdown could not see a parallel run | A lane copies the workspace before registering, so shutdown looked, found nothing, and closed the store underneath it |
| Interrupted tasks left their unstarted steps queued forever | A failed task above a pending step reads as work about to resume |
| A deleted reservation went on being enforced | The store had a delete and the pool manager did not |
| A blocked release gate could never fail | A reason string was treated as proof the evidence could not run |

Each is closed, with a mutation-verified test. Two findings in the audit's
output were judged not to be defects on reading the code, and are not listed.

Writing the concurrent-start test found a defect nothing else would have:
`PRAGMA journal_mode = WAL` does not go through SQLite's busy handler, so the
second of two gateways starting together died on the first line of the database
layer with an error that named no file and suggested no cause.

Every fix in this pass was mutation-verified: the fix was removed and the test
watched to fail, then restored. Where a test passed under mutation, the test was
strengthened until it did not — the concurrent-start test needed a barrier and a
deliberately slow migration before it could tell the two lock modes apart.

---

## Honesty notes

Things worth stating plainly, because a report that omits them is worth less
than one that does not exist.

**The local inference server is not a model.** `scripts/local-model-server.mjs`
implements the OpenAI wire protocol faithfully — real SSE, real index-keyed
tool-call fragments, real usage — but its responses come from a rule-based
policy. Everything it verifies is about Meridian. Nothing it verifies is about
model quality, and no row in any of these documents claims otherwise.

**"BLOCKED_EXTERNAL" is not "probably fine".** It appears thirty times, and each
is a genuine external dependency — a credential, a registry, an egress policy —
with the failure recorded. None has been converted into a pass.

**Container sandboxing is unverified here.** The earlier report called this gate
VERIFIED on the strength of a verification-only image assembled from host
binaries. This environment has no Docker daemon at all, so the gate now reads
BLOCKED_EXTERNAL, which is what the run says. The process-sandbox fallback is
verified, including the warning that says it is not a security boundary.

**Six of nine agents, not nine.** The orchestrator, researcher and debugger were
not selected by the pipelines exercised here. They share the verified machinery;
their own sequencing is untested, and the matrix says so.

**Reservations are verified sequentially, not under load.** Their budgets bind,
and now survive a restart. Many callers consuming one reservation at once is
still IMPLEMENTED_UNVERIFIED.

**The upgrade test is one version step.** It carries a real previous-release
database forward with its data, which nothing did before. It is not a fleet
upgrade, a downgrade, or a multi-version jump.

**Known and not fixed in this pass.** The audit surfaced three further real
issues that are left open rather than quietly dropped:

- A pool's budget reservation sizes an image request as one call, so a request
  for *n* images can bill *n*× what it reserved. Pre-existing, in the router's
  estimate rather than in this pass's work.
- Shutdown does not await the detached discovery refresh, so pacing state
  written during that window can be lost — the same class of gap migration 011
  closed for the ordinary path.
- The capability inspector's Verify button never sends `allowPaid` and never
  renders the `skipped` list, so a run refused entirely for cost reasons
  displays as though it found nothing. The API is correct; the screen does not
  show what it returns.

---

## Recommended next steps

1. **Add one free provider credential** (Groq or OpenRouter) and run
   `pnpm test:live`. This is the single highest-value action available: it
   converts twenty rows from BLOCKED_EXTERNAL to measured.
2. **Build the real sandbox image** where a registry is reachable, then
   `docker compose up -d` and re-run the E2E suite against it. That converts two
   gates.
3. **Cover the three unexercised agents** with pipelines that select them.
4. **Drive reservations under concurrent load**, which is the only way that row
   moves.
5. **Drive the in-app editor, terminal and checkpoint controls**, which the
   screen-level tests render but do not operate.
