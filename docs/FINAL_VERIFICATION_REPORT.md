# Final verification report

A second pass over Meridian: audit against the specification, reproduce every
gap, close what could be closed, and report what the evidence actually supports.

Generated alongside `docs/evidence/RELEASE.md`, which `pnpm verify:release`
writes from a run rather than from a claim.

---

## Release classification

### BETA

Meridian is a real, working product. Its gateway, router, agent runtime and
sandbox have been exercised end to end against real servers and real containers,
and the second pass closed nine defects — two of which would have made Docker
sandboxing silently useless in the shipped configuration.

It is not a release candidate, and the reason is simple and unglamorous: **not
one of its twenty-four providers has been exercised against its real API.** No
credential is present in this environment and most provider hosts are
unreachable from it. A universal AI gateway whose provider integrations have
never sent a real request is not a release candidate, however good its internals
look, and calling it one would be the exact rounding-up this pass exists to
prevent.

What separates BETA from RELEASE CANDIDATE here is external, not architectural:

1. One provider credential and a `pnpm test:live` run.
2. Registry access, then `docker compose up -d` against the real images.
3. An image- and a speech-capable credential for the media modalities.

None of the three requires a code change. All three are blocked by this
environment, not by the product.

### Why not the neighbouring classifications

**Not PROTOTYPE or ALPHA.** 237 tests pass, including 52 that cross a socket and
a process boundary into a real inference server, 18 that drive the web client in
a real browser, 13 that attack the running gateway, and 10 that exercise real
containers. The autonomous coding pipeline
writes files that exist on disk afterwards. State survives a restart. This is
past the point where "does it work at all" is the open question.

**Not RELEASE CANDIDATE.** See above. Also: three of nine agents, eight of
fifteen CLI commands, the WebSocket transport, reservations under load and the
in-app editor and terminal have no end-to-end coverage. Each is
IMPLEMENTED_UNVERIFIED — real code, no evidence — and a release candidate should
not have that much of its surface in that state.

**Not PRODUCTION READY.** No live provider, no verified container deployment, no
production soak, no load testing, no upgrade-path testing beyond a single
restart.

---

## Feature scorecard

Counted across [VERIFICATION_MATRIX.md](VERIFICATION_MATRIX.md),
[PROVIDER_VERIFICATION.md](PROVIDER_VERIFICATION.md),
[AGENT_VERIFICATION.md](AGENT_VERIFICATION.md) and
[MODALITY_VERIFICATION.md](MODALITY_VERIFICATION.md), each of which lists its
rows' evidence. Regenerate with `node scripts/scorecard.mjs --write`.

| Status | Count | Share |
| --- | ---: | ---: |
| VERIFIED | 145 | 71% |
| IMPLEMENTED_UNVERIFIED | 25 | 12% |
| PARTIAL | 5 | 2% |
| BLOCKED_EXTERNAL | 30 | 15% |
| MISSING | 0 | — |
| STUB | 0 | — |
| FAILED | 0 | — |

205 claims across the four matrices, counted by `node scripts/scorecard.mjs`.

The BLOCKED_EXTERNAL share is high because the provider matrix contributes
twenty rows of it: twenty remote providers, none credentialed here. That single
fact is what holds the classification at BETA.

No capability is MISSING or STUB. A scan for `TODO`, `FIXME`, `NOT_IMPLEMENTED`
and placeholder returns across `apps`, `packages` and `tests` finds one match: a
`placeholder` prop on a form input.

### By area

| Area | Verdict |
| --- | --- |
| Routing | VERIFIED — including the guarantees, as invariants over 400 generated registries |
| OpenAI-compatible API | VERIFIED for text, streaming, tools, embeddings, model listing |
| Anthropic-compatible API | VERIFIED for text, streaming, tool use |
| Agent runtime | VERIFIED — six of nine agents exercised; the runtime around all nine is |
| Sandbox | VERIFIED against real containers |
| Security | VERIFIED — nine adversarial classes, five defects found and closed |
| Persistence | VERIFIED across a full restart |
| Provider integrations | IMPLEMENTED_UNVERIFIED / BLOCKED_EXTERNAL — the contract is enforced mechanically; no live request has been sent |
| Media generation | IMPLEMENTED_UNVERIFIED — the refusal path is verified, the success path needs a provider |
| Web client | VERIFIED — eleven screens in a real browser, three viewports, both themes, live data |
| CLI | PARTIAL — seven of fifteen commands verified end to end |
| Docker deployment | PARTIAL — sandbox and persistence verified; build and compose blocked |

---

## Release gates

From `docs/evidence/RELEASE.md`, regenerated on every `pnpm verify:release`.

| Gate | Status |
| --- | --- |
| Deployment: persistence and container configuration | PARTIAL |
| Web client | VERIFIED |
| Core routing | VERIFIED |
| Anthropic-compatible surface, end to end | VERIFIED |
| Autonomous coding pipeline | VERIFIED |
| Fallback and resilience | VERIFIED |
| Sandbox isolation | VERIFIED |
| Multimodal surfaces | PARTIAL |
| Security | VERIFIED |

Seven of nine VERIFIED; two PARTIAL for reasons named in the report and outside
the product.

---

## What the second pass changed

Nine commits, +6,111 / −112 across 69 files, 143 → 237 tests.

| Commit | What it closed |
| --- | --- |
| A real local inference server and an E2E suite | The verification floor: nothing had crossed a socket. Also found a test suite that had never run, and a routing explanation that misreported the user's chosen mode |
| Readiness, onboarding, idempotency, stream deadline | Four platform gaps; found streamed errors reporting only the last failure, and SSE responses missing their security headers |
| Checkpoints, rewind and forking | An agent run could not be undone a step at a time |
| Docker sandboxing | Two defects that made `MERIDIAN_SANDBOX=docker` silently useless as shipped |
| Adversarial security pass | Two SSRF bypasses, secrets echoed in errors, one body limit for every route, an IPv6 mapping hole |
| Provider contract and router invariants | Endpoint variables read as credentials; seven undocumented variables; the honesty rules turned from prose into tests |
| Release and live verification tooling | No way to reproduce a verification claim; no guarded path to spending real money |
| The verification documents themselves | Claims nobody could check; the scorecard is now derived from the matrices rather than typed |
| The web client in a real browser | The largest unautomated surface. Also found the home screen truncating its sandbox warning mid-sentence, dropping the words "not a security boundary" |

Ten defects in total: nine found by running the product, one by rendering it.

---

## Honesty notes

Things worth stating plainly, because a report that omits them is worth less
than one that does not exist.

**The local inference server is not a model.** `scripts/local-model-server.mjs`
implements the OpenAI wire protocol faithfully — real SSE, real index-keyed
tool-call fragments, real usage — but its responses come from a rule-based
policy. Everything it verifies is about Meridian. Nothing it verifies is about
model quality, and no row in any of these documents claims otherwise.

**The sandbox image used in tests is not the shipped one.** The real image's
base layer cannot be pulled here, so isolation was verified against a minimal
image assembled from host binaries. The flags, the mount semantics and the uid
are identical; the toolchain inside is not present.

**"BLOCKED_EXTERNAL" is not "probably fine".** It appears nine times in the
matrix and each is a genuine external dependency — a credential, a registry, an
egress policy — with the failure recorded. None of them has been converted into
a pass.

**Six of nine agents, not nine.** The orchestrator, researcher and debugger were
not selected by the pipelines exercised here. They share the verified machinery;
their own sequencing is untested, and the matrix says so.

**The first pass's completion report was not trusted.** Every claim in it was
re-derived from a run. Nine of them turned out to be wrong.

---

## Recommended next steps

1. **Add one free provider credential** (Groq or OpenRouter) and run
   `pnpm test:live`. This is the single highest-value action available: it
   converts twenty-four rows from IMPLEMENTED_UNVERIFIED to measured.
2. **Build the real sandbox image** where a registry is reachable, then
   `docker compose up -d` and re-run the E2E suite against it.
3. **Cover the three unexercised agents** with pipelines that select them.
4. **Drive the in-app editor, terminal and the checkpoint controls**, which the
   screen-level tests render but do not operate.
5. **Drive rate limiting and reservations under concurrent load**, which is the
   only way those two rows move.
