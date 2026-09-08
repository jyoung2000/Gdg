# Current state audit

A code-level audit of Meridian as it stands, done by reading the source rather
than the documentation. Where the two disagree, this file follows the code and
says so.

Classifications used throughout:

| | |
| --- | --- |
| **IMPLEMENTED** | Works, and something proves it |
| **IMPLEMENTED_BUT_UNVERIFIED** | The code is real; nothing in this environment can exercise it |
| **PARTIAL** | Works for some of what its name implies |
| **BROKEN** | Present and wrong — worse than absent, because it is trusted |
| **MISSING** | Does not exist |

## The shape of the thing

53,958 lines of TypeScript across 12 packages and 3 apps, 39 database tables in
7 migrations, and a test suite of 473 tests. It is not a prototype. The gaps
below are the gaps of a real system, and several of them matter precisely
because everything around them works well enough to be trusted.

The single theme running through the serious findings: **Meridian is good at
representing what it knows and weak at representing what it does not.** Unknown
price became `$0`. Unverified capability became a name guess. An operator's
"this model cannot do that" became "inferred: it can". In each case a real
value was substituted for a missing one, and every consumer downstream then
treated the substitute as fact.

---

## BROKEN

### 1. Unknown price ranked as the cheapest price — **fixed in this pass**

`packages/routing-sdk/src/router.ts:343` (before the fix):

```ts
const cost = estimatedCost <= 0 ? 1 : clamp01(1 - Math.log10(estimatedCost * 10_000 + 1) / 4);
```

`estimateCost` returned `computeCost(...)`, and `computeCost` adds only the
rates that are non-null — so a `METERED` model publishing no rates returned
**0**, and 0 took the `<= 0` branch and scored **1.0, the maximum**. Three
consequences, all live:

- Under `CHEAP_FIRST` an unpriced model outranked every model with a real,
  published, genuinely-cheap rate. It won *because* nothing was known about it.
- `router.ts:283` compared that same 0 against `req.budget`, so an unpriced
  model **fitted every budget ever set**, including a $0.01 one.
- `pools.capacityBlock` charged 0 against pool and reservation budgets, so a
  **no-spend pool did not stop it**.

This is the exact failure the earlier pricing work set out to prevent and
missed: `isFree()` was fixed to refuse "unpublished means zero", but
`computeCost` still returned zero for the same input, and the router read
`computeCost`. Fixed by `packages/shared/src/economics.ts` — see
[PRICING_ENGINE.md](PRICING_ENGINE.md).

### 2. An operator's "this model cannot do that" inverts itself on restart

`POST /api/models/:id/capabilities` records an operator judgement as a
`CapabilityClaim` and calls `store.upsertModels`. But the `models` table has no
column for claims — `database/migrations/001_initial.sql:106` lists 14 columns
and none of them is `capability_claims` — so `store.ts:389` writes the flat
`capabilities` array and drops the claim.

Marking vision *unsupported* removes it from the array. On the next boot
`enrich()` re-runs, and `packages/model-sdk/src/heuristics.ts:122` unions the
name heuristic straight back in:

```ts
capabilities: [...new Set([...model.capabilities, ...hint.capabilities])],
```

So for any model whose id matches the vision regex, an operator's explicit "I
tested this, it cannot see images" becomes "inferred: it can see images" after a
restart. The comment at `heuristics.ts:126` — *"Anything already established
(a probe result, an operator's confirmation) outranks both of the above and
survives re-enrichment"* — is true in memory and false across a process
boundary.

### 3. Images estimated at zero tokens — **fixed in this pass**

`router.ts:394` (before the fix):

```ts
req.prompt ?? (req.messages ?? []).map((x) => (typeof x.content === 'string' ? x.content : '')).join('\n');
```

Any multimodal message contributed an empty string. A request carrying ten
screenshots — the densest payload a prompt can hold — estimated at **zero
prompt tokens**, cleared every budget and fitted every context window. Fixed by
`packages/shared/src/tokens.ts`.

---

## MISSING

### 4. Context optimization — nothing exists

No trimming, no compaction, no summarisation, no relevance selection, no token
budget. Searched for `truncate`, `compact`, `summarize`, `prune`, `elide`,
`maxContext`, and message-list slicing. What exists instead is a set of
unrelated fixed character caps on individual strings
(`MAX_RESULT_CHARS = 40_000`, `PROJECT_KNOWLEDGE_BUDGET = 24_000`) — no budget
is ever computed against the target model's actual window.

`AIRequest.contextLength` is declared and the router filters on it
(`router.ts:236`), but **no production caller ever sets it**; the only writer is
an admin debug route. So the router cannot reject a model for being too small
for the payload it is about to receive.

The agent loop is where this bites hardest: `packages/agent-sdk/src/loop.ts:163`
grows one `messages` array across up to 40 turns, re-sending it whole each time,
with 40 KB permitted per tool result and no window check anywhere.

### 5. MCP tools never reach a model

The MCP client is real — genuine stdio spawn and streamable HTTP with SSE
parsing, proven by an e2e test that round-trips a call against
`@modelcontextprotocol/server-everything`. The control plane resolves which
servers are active per scope. And then nothing happens:
`apps/gateway/src/routes/shared.ts:84` computes `config.mcpServers` on every
request and **discards it**. There is no `McpToolInfo → ToolDefinition` adapter
anywhere in the repository, and `grep -i mcp packages/agent-sdk/src` returns
nothing.

The only way an MCP tool executes today is a human clicking *Call* in the UI
playground. Every scope toggle, policy and assignment for MCP is, at inference
time, decoration.

### 6. Nothing writes `probe_verified`

`CapabilityClaims` is a well-designed six-state evidence model with
`probe_verified` ranked highest. No code produces it. There is no active
capability probing of any kind — `healthCheck` is a provider-level liveness
ping that takes no model id and has nowhere to put a capability result.

Meanwhile `apps/web/src/screens/AIControlScreen.tsx:352` renders the label
**"Verified by a live call"**, which no model can currently earn, and
`packages/computer-sdk/src/routing.ts:87` awards `probe_verified` a +0.35
scoring bonus that can never be claimed.

Related: `ProviderRegistry.setVerified` stores `adapter.capabilities()`, and
`packages/provider-sdk/src/adapter.ts:101` computes that from
`typeof adapter.chat === 'function'` — compile-time introspection of which
methods were written, identical whether any call ever succeeded. It is the
adapter's surface, not evidence.

### 7. Review is not independent, and test failure is invisible

Both halves of "independent review with escalation" are absent:

- **No model diversity.** Nothing compares the reviewer's model to the
  implementer's, and `AIRequest` has no field that could express it — no
  `excludeModels`, no family concept anywhere in the codebase. The built-in
  pools ship with `members: []`, so implementer and reviewer draw from the same
  universe and `scoring.ts:58` maps `review` and `coding` onto the *same*
  quality dimension. On a single-provider instance the reviewer is routinely the
  same model that wrote the code.
- **Test failure is not detected.** `packages/agent-sdk/src/tools.ts:262`
  returns a non-zero exit as `isError: false` (deliberately, so the model
  debugs rather than retries) — but nothing else ever parses the result, so a
  tester step whose suite failed is recorded as `completed`. `orchestrator.ts:334`
  excludes `tester` and `reviewer` from the roles whose failure stops a task, and
  the reviewer is the last step in every pipeline, so its findings are appended
  to a context nothing reads. `testsPassed` exists in the scoring API and is
  dead end-to-end: no caller ever passes it.

Note `THIRD_PARTY_NOTICES.md` credits Codebuff with the concept "reviewing with
a different model family than the one that implemented". The concept was read;
the behaviour was not built. That line has been corrected.

### 8. Live quota

`QuotaState` is defined and its helpers are correct. Nothing constructs one. The
`quotas` table has no reader and no writer. Free-first routing therefore cannot
avoid a route whose daily allowance is already spent — it finds out by getting a
429.

### 9. Prompt caching

No `cache_control` is emitted, and `cache_read_input_tokens` /
`prompt_tokens_details.cached_tokens` are parsed off the wire and discarded.
`Usage` has four fields and none of them is a cached-token count, and `Pricing`
has no cached-input rate, so a saving could not be expressed even if it were
measured. Worth noting: the current assembly order prepends the *most volatile*
content (project file bodies) ahead of everything else, which is precisely
backwards for prefix caching.

---

## PARTIAL

### 10. Token counting

One estimator, `estimateTokens = ceil(len / 3.7)`, **duplicated** by copy-paste
in `packages/control-sdk/src/skills.ts:24`, plus a third divisor `/4` in
`apps/gateway/src/routes/shared.ts:183`. No tokenizer library. Tool schemas,
message framing and images were counted at zero. Replaced this pass by
`packages/shared/src/tokens.ts`.

### 11. Three unconnected confidence vocabularies

`ConfidenceLevel` (5 levels, age-aware, `STALE_AFTER_DAYS = 90`),
`CapabilityState` (6 states, **age-blind**), and `TrustLevel` (4 levels, manual
and unrelated to verification). `CapabilityClaim.at` is written by every
producer and never compared against a clock, so a `user_confirmed` claim from
two years ago permanently outranks a `provider_declared` one from this morning.

And "verified" means two different things: a provider whose descriptor says
`trust: 'verified'` has had nothing verified — `discovery.ts:200` hardcodes it
for any local endpoint that answers a TCP connect.

### 12. Health is provider-keyed only

The circuit breaker, error rates and cooldowns are all real and persisted, but
keyed by `providerId`. There is no per-model health, so a single broken model on
an otherwise healthy provider cannot be taken out of rotation. Per-model
*performance* (p95, jitter, uptime) does exist and is persisted.

### 13. Browser: one backend behind a good seam

`BrowserProvider` is a clean pluggable interface with exactly one implementation
(Playwright). The three "engines" are three configurations of that one class;
lightpanda and remote-CDP are `IMPLEMENTED_BUT_UNVERIFIED` (no binary or
endpoint has ever been available here). Real: navigation, refs, click/fill,
screenshots, tabs, a11y snapshot, storage-state persistence sealed at rest.
Missing: cookies API, uploads, downloads (refused by policy on purpose).

Two things to flag rather than bury:

- **No HTTP-vs-headless arbitration exists.** `engine: 'auto'` resolves to
  `['chromium']`, the heaviest option; the choice between `browse` and
  `web_fetch` is a sentence in a system prompt. `research.ts:186` always spins a
  full browser and then polls 4×750ms hoping content appears, when
  `guardedFetchText` one package over would answer most pages immediately.
- **SSRF parity gap.** The HTTP path installs a DNS `lookup` guard against
  rebinding; the browser path checks hostnames textually only, so a public name
  resolving to `10.x` passes. The gateway also allow-lists `localhost` by
  default for every session it creates.

### 14. Sandbox

Genuinely good, and honest about its limits: the Docker path drops all
capabilities, sets `--memory-swap` equal to `--memory` (so the cap cannot be
evaded by swapping), goes read-only with a `noexec` tmpfs, and probes a real
mount round-trip at startup. `process` mode declares itself
*"Not a security boundary"* in its own `isolationSummary` and builds its
environment from an allowlist so no provider credential leaks into a subprocess.
Degradation is announced, never silent.

### 15. Agent tests

No test constructs an `AgentLoop` or an `Orchestrator`. The loop, `maxSteps`
exhaustion, tool-error recovery, cancellation, the blocking-role rule, and
`ParallelRunner` in its entirety are uncovered. Two integration assertions cover
2 of 9 pipeline branches; the real run is covered only by a live-gated e2e test.

---

## IMPLEMENTED (verified this pass or previously, and still true)

- Two-phase routing: hard constraints then weighted scoring, 15 modes, with
  `FREE`/`LOCAL` as genuine hard constraints rather than preferences.
- Executor: shared retry budget across the whole fallback chain, `Retry-After`
  honoured, full-jitter backoff, same-target cap of 2, different-provider-first
  chain ordering.
- Circuit breaker: closed/open/half-open with exponential cooldown, persisted,
  and deliberately *not* driven by synthetic probes.
- Price book: ~3,800 LiteLLM entries, same-provider-only matching, anti-shrink
  guard, offline-safe boot.
- Discovery: live listing per provider with change detection into
  `model_changes`, paced by a scheduler with backoff.
- Checkpoints: taken *before* each step, touched files only, 1 MB cap with an
  explicit `skipped[]` so a rewind cannot lie.
- Credential isolation: sealed at rest, per-caller resolution, redaction on
  every read path.
- MCP client transport, both stdio and streamable HTTP, e2e-proven.
- Local inference E2E: 91 tests against a real inference server over a real
  socket.

---

## What this audit changed immediately

The two BROKEN money findings (#1, #3) were fixed in the same pass that found
them, with tests that fail against the old code. Everything else is scheduled in
[MERIDIAN_HARDENING_PLAN.md](MERIDIAN_HARDENING_PLAN.md).
