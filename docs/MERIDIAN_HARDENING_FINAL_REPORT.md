# Meridian hardening — final report

Eight commits, 60 files, ~5,600 lines added. What follows separates what was
built from what was proved, and both from what is still missing.

## The one finding behind most of the others

Meridian was good at representing what it knew and weak at representing what it
did not. Every serious defect found was the same shape: **a missing value had
been replaced by a real-looking one, and everything downstream then treated the
substitute as fact.**

| Missing thing | Became | Consequence |
| --- | --- | --- |
| An unpublished price | `$0` | Won every cheap-route comparison; fitted every budget |
| An untested capability | A name guess | Routed to models that would fail the request |
| An operator's "this model cannot" | "inferred: it can" | Overturned on the next restart |
| A failing test suite | A completed step | Tasks reported success when the tests failed |
| An image's token cost | `0` | Ten screenshots cleared every budget and window |

That is why the work is ordered the way it is. Teaching the system to carry
uncertainty came before adding capability, because a feature built on a
confident wrong answer inherits the wrong answer.

---

## Implemented

### Cost safety

`packages/shared/src/economics.ts` answers the cost question with a value *and*
its epistemic status — exact, a lower bound, or unknown — so unknown has to be
handled rather than silently becoming zero. A limit that cannot be proven is a
refusal: budgets, per-task caps and pool ceilings all decline a model whose
price nobody publishes and say so in those words. Ranking follows the same rule.

`packages/shared/src/tokens.ts` replaced three divergent character heuristics
with one estimator that counts message framing, tool schemas and images, and can
break a request down by where its tokens went.

### Capability evidence

Migration `008` gives claims, first-sighting and last-verified somewhere to
live. Two structural fixes came out of writing the test:

- The flat capability list is now a **projection of the merged evidence** rather
  than an independent union beside it, so a heuristic cannot reinstate something
  that was ruled out.
- `unsupported` ranked *below* `inferred`, so a name guess outranked a tested
  negative. It now ranks with `user_confirmed`, because the ranking orders
  evidence quality, not conclusions.

### Probing

`packages/provider-sdk/src/probe.ts` sends the smallest request that can tell
"does this" from "does not". Three outcomes, and the third is the design: only a
*definitive refusal* means unsupported; a 429 or a timeout writes no claim at
all. Exposed as `POST /api/verification/run`, `uag verify`,
`pnpm verify:providers`, and a **Verify with a live call** button.

### Context optimisation

`packages/context-sdk` — measure, select, transform, verify, report. Wired into
the agent loop per turn, in AUTO, so short steps are untouched. The safety check
can undo the whole pass rather than warn, falling back to a gentler mode.

### MCP reaching a model

The MCP client and the control plane both worked and had never been joined:
`config.mcpServers` was computed per request and used only to render an
explanation. Tools are now exposed as `server__tool`, routed back by exact
binding lookup, bounded by relevance plus a hard ceiling, never shadowing a
built-in, and marked mutating without exception.

### Verification outcomes

A command's exit code reaches the orchestrator. A verifying step whose commands
failed is recorded failed, the failure reaches the next step's context, the task
reports it, the verdict feeds the model's learned quality score — the first
producer `testsPassed` has ever had — and one bounded repair attempt is
appended.

### Browser

Navigation resolves the hostname and checks every address, closing the
public-name-resolving-private hole the HTTP path had guarded for a while. A
plain GET is tried before launching Chromium, with escalation decided by the
response rather than the URL.

---

## Verified

Everything below was executed, not reasoned about.

| Claim | Evidence |
| --- | --- |
| Unknown price loses to a published expensive one under CHEAP_FIRST | `tests/router/cost-honesty.test.ts`, red against the old code |
| A budgeted request cannot select an unpriced model | Same file; the contract suite now asserts `expectedCost != null` under a budget |
| Capability evidence survives a restart | A second `Store` on the same file returns `unsupported`; re-enrichment does not undo it |
| A probe can earn `probe_verified` | e2e against the local inference server: `text` verified in 37ms, `embedding` as a 384-dimension vector |
| An inconclusive probe records nothing | e2e against the always-failing server: claims byte-identical before and after |
| Context optimisation saves what it claims | Benchmark: 79%/94%/89%/97% across four fixtures, every row passing the independent safety check |
| Optimisation declines when it should | Short chat skipped; 8 screenshots save 0% — both reported as zero |
| MCP tools round-trip to the right server | 11 unit tests including a name that resolves to no exposed server |
| A failing command is distinguishable from a failing tool | `tests/unit/verification-outcome.test.ts` |
| The browser SSRF hole is closed | `localtest.me` passes the textual check, resolves to 127.0.0.1, navigation refused |
| A server-rendered page skips Chromium | Live against a real socket: `transport=http`, 1,465 chars, **0 browser launches** |
| The probe→evidence→listing loop closes | `uag models` shows `declared`, `uag verify` runs, listing shows `probed` |

**Suites at the time of this report:** unit 291, e2e 94, integration 27, router
73, contract 24, chaos 12, UI 28. All passing, 0 failures, 1 skipped (needed
Chromium). Superseded by
[Phase 4](MERIDIAN_PHASE4_IMPLEMENTATION.md): 594 tests, 0 failures.

---

## Unverified

Real code, not exercisable here.

- **Every hosted provider.** Two APIs turned out to be reachable — see
  [Phase 4](MERIDIAN_PHASE4_IMPLEMENTATION.md) — but only unauthenticated, which
  proves transport and error classification and nothing about capability. The
  other nine adapters, the probes against them, and the price book's real rates
  are exercised only against the local inference server and cached data.
- **Lightpanda and remote-CDP browser engines.** No binary or endpoint has ever
  been available in this environment.
- ~~**MCP tools inside a live agent run.**~~ Verified in Phase 4 against an MCP
  server written into the repository, so the join no longer needs a published
  server or a network to exercise.
- **Docker sandbox mode.** `MERIDIAN_SANDBOX=process` throughout.

---

## Token optimisation

Measured by `scripts/benchmark-context.mjs`; full table in
[TOKEN_OPTIMIZATION_BENCHMARK.md](TOKEN_OPTIMIZATION_BENCHMARK.md).

| Fixture | Before | After (BALANCED) | Saved |
| --- | ---: | ---: | ---: |
| Short chat | 520 | 520 | 0% *(skipped)* |
| Agent, 6 turns on one file | 5,702 | 1,174 | 79% |
| Agent, 20 turns | 31,196 | 1,790 | 94% |
| Long chat, no repetition | 9,928 | 1,067 | 89% |
| Agent, 40 turns | 93,136 | 2,560 | 97% |
| 8 screenshots | 6,658 | 6,658 | 0% |

Optimising costs 0.02–7.5ms. The two zeroes are the honest rows.

Writing this benchmark caught a real design error. The first safety contract
required *every* user message to survive verbatim, so windowing a long
conversation always failed the check and fell back — long chats reported 0%. The
fix was not to weaken the guarantee but to move it: `windowHistory` hoists the
concrete references a dropped turn named into the marker it leaves. 0% → 89%.

---

## Provider coverage

| | Count |
| --- | --- |
| Adapter implementations registered | 11 |
| Providers in the shipped catalog | 24 |
| After a live free-model sync | 52 |
| Providers reached at their real API here | **2** — Anthropic and Google, unauthenticated only. See [Phase 4](MERIDIAN_PHASE4_IMPLEMENTATION.md) |
| Providers verified with a credential here | **0** (no credential exists in this environment) |
| Models with `probe_verified` evidence here | 4 (the local inference server) |

---

## Security

- **Browser SSRF parity.** Navigation resolves and checks every address. The
  rebinding *race* remains open and is documented as such — closing it needs a
  hook inside the browser's socket layer Playwright does not expose.
- **MCP containment.** Every MCP tool is marked mutating; a built-in tool can
  never be shadowed; a call to a tool not offered for this request is refused
  rather than resolved by parsing its name.
- **Probe blast radius.** Probes never run on a timer, never without a
  credential, and a run states what its cap dropped.
- Unchanged and still holding: credential sealing and per-caller resolution,
  the allowlist-built sandbox environment, Docker isolation flags, admin gating
  on `evaluate` and on verification runs.

---

## Performance

- Context optimisation: 0.02–7.5ms per turn, against savings of tens of
  thousands of tokens.
- HTTP-first scraping: a server-rendered page now costs one GET instead of a
  browser launch plus up to 3s of polling.
- Probes: 32–37ms each against the local server; sequential by design, because
  a burst is the fastest way to earn the 429 that makes every probe
  inconclusive.

---

## Remaining work

Ordered by what would matter most next.

1. ~~**Live quota.**~~ Done in Phase 4, per account rather than per provider:
   response headers are parsed into a per-credential allowance, and an account
   with a spent published quota is not offered to the router. An unpublished
   quota is still never read as "plenty".
2. **Re-verification scheduling.** A claim older than 90 days is now discounted,
   but nothing decides when to spend quota re-probing it. That is a policy
   question with a real bill attached.
3. **Review model diversity.** The reviewer's *verdict* now counts; whose
   verdict it is does not. `AIRequest` has no field that could exclude the
   implementer's model, and there is no model-family concept in the codebase.
4. **Per-model health.** The breaker is provider-keyed, so one broken model on a
   healthy provider cannot be removed from rotation.
5. **The gateway chat surfaces.** Context optimisation is wired into the agent
   loop only. The OpenAI and Anthropic surfaces still assemble additively, and
   the three assembly paths are still three.
6. **Prompt caching.** Nothing emits `cache_control`; the cached-token counts
   providers return are parsed and discarded; `Usage` and `Pricing` have no
   fields for either. The current assembly order puts the most volatile content
   first, which is backwards for prefix caching.
7. ~~**`setVerified` stores compile-time introspection.**~~ Done in Phase 4:
   `adapter.surface()`, `recordLiveContact`, and an `adapterSurface` field, with
   the ceiling and the evidence shown side by side in the capability matrix.
8. **Probe coverage.** Four capabilities have probes. JSON mode, structured
   output, reasoning, audio and video do not.
9. **Agent-loop unit tests.** No test constructs an `AgentLoop` or
   `Orchestrator`; `ParallelRunner` has none at all.

## The standard applied

Nothing in this report claims a capability the code cannot perform. Where
something could not be exercised, it is listed under *Unverified* with the
reason. Where a feature is partial, the partial half is named. Two documents
that previously overstated what was built — the upstream matrix on review
diversity, and the agent verification doc on what a tester's verdict meant —
were corrected as part of this work rather than left to be discovered.
