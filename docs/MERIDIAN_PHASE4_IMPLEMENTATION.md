# Meridian Phase 4 — Universal AI Control Plane

What was built, what was proved, and what is still not true.

The organising rule of this pass, taken from the brief: **code existing is not a
feature.** Every row below is either exercised through the real execution path
or is named as unverified with the reason. Where the two disagreed, the code
lost.

---

## The shape of what was wrong

Four defects, and three of them are the same defect wearing different clothes:
**a fact was recorded against the wrong thing, and everything downstream then
reasoned about the wrong subject.**

| The fact | Was recorded against | What that cost |
| --- | --- | --- |
| One caller's key was rejected | The **provider** | The provider's breaker opened for every other caller on the instance |
| A test verdict for a step | The **role** | Escalation runs `tester` twice; a repair's pass was credited to the run that failed |
| Which methods an adapter has | A field called **`verifiedCapabilities`** | Clients were told a live call had confirmed capabilities nobody had tested |
| Google saying a key is invalid | **`invalid_request`** | No failover, no account cooldown, and a caller told their request was malformed |
| Whether a provider serves a modality | **Whether a method exists** | Most providers use a base class that defines every method, so "no fake support" passed almost everything |

The fourth is different in kind and worth naming separately: the **web UI suite
was testing a bundle, not the sources.** Every other suite runs the TypeScript
the product runs; that one loaded whatever `dist/web` happened to hold, so it
could pass every screen against last week's code and read exactly like a real
pass.

---

## What was built

### Request trace (§19)

Meridian handed every caller an `x-request-id` and kept nothing that could be
looked up by one. No index selected on it, no query accepted it, and the routing
decision that spent the money was computed in full, returned once, and dropped.

- Migration `009` adds `step_id`, `routing` and `context_tokens_saved` to
  `usage`, and indexes `request_id` and `step_id`.
- The executor records a **routing snapshot** per attempt — the applied policy
  and the one asked for, the winner and its four closest runners-up, and
  rejections collapsed to reason-plus-count. Not the whole `RoutingReason`: the
  considered list runs to dozens and the rejection list into the hundreds, and
  "47 candidates lacked a credential" is more legible, and far cheaper, than 47
  lines.
- The agent loop passes the **step**, not just the role, and the tokens the
  optimiser kept out of that call.
- `GET /api/trace/:requestId` returns every attempt in order — including the
  ones that failed — with the model each reached, the cost, and why it went
  there. Scoped exactly like `/api/usage`: a non-admin sees only their own rows,
  and an unknown id is indistinguishable from someone else's.
- `uag trace <requestId>` and a selectable row on the Usage screen.

### Accounts: per-credential health and quota (§20)

Meridian's account is a credential — it is what a provider meters, bills and
revokes — and nothing was recorded against one.

- `CredentialHealthStore` holds state, cooldown and published quota per account,
  persisted by migration `010` and reloaded on boot.
- **Failures are split by cause.** A 401, a 429 or a spent quota is a fact about
  the account and stops there. A timeout, a 5xx or an unreachable host is a fact
  about the service and stays on the provider's breaker. An anonymous endpoint
  has no account to blame, so its rate limit still opens the provider's breaker
  — with no credential, the provider is the only thing that could be limiting
  us.
- **Routing consults it before choosing.** An account on cooldown is not
  capacity, so it is not offered; where a second key exists the call simply uses
  it. The rejection reason finally distinguishes "none configured" from "all of
  them are busy", which used to send an operator to add a key they already had.
- **Quota comes from response headers**, where providers actually publish it,
  via one parser covering the `x-ratelimit-*`, `anthropic-ratelimit-*` and IETF
  `ratelimit-*` families and the three ways a reset is written. Getting it from
  ~60 adapter call sites back to the executor uses an async-local sink rather
  than a callback threaded through each one: a forgotten call site is silent,
  and silence here means an account's quota simply never updates.
- Every quota field stays nullable, and **null is never read as "plenty"**. A
  zero whose window has since reset stops applying rather than retiring a
  working key.
- `CredentialPool`'s `health` strategy was a stub — advertised, accepted,
  persisted, and identical to `priority`. It now sorts by which key is working.
- Surfaces: `/api/credentials` carries each account's standing,
  `POST /api/credentials/:id/reset-health` is the operator's override,
  `uag accounts`, and the provider dialog.

### Capability truth (§ capability matrix)

`setVerified(id, adapter.capabilities())` stored `typeof adapter.image ===
'function'` and published it as `verifiedCapabilities`.

- `adapter.surface()` says which methods exist — a ceiling, a fact about this
  codebase, no evidence about the provider.
- `recordLiveContact` says a call succeeded, which is all `supportState:
  'supported'` ever meant and now all it claims.
- `GET /api/capabilities` puts both in one table, per provider: what the adapter
  can execute, and the strongest evidence across its models per capability with
  the count behind it. The cell summarises the strongest **positive** claim, so
  one model's tested negative cannot summarise thirty that declare the
  capability; `unsupported` still appears in the counts, because it answers a
  different question. Unknown is reported as unknown, never as no.
- A **Matrix** tab on the AI screen that leads on that distinction in words.
- The **"no fake support" guard was half true** and writing its first test found
  it. It asked whether the adapter had a method for the modality; the
  OpenAI-compatible base — which most providers use — defines every method and
  refuses at call time for the ones its instance lacks. So a chat-only endpoint
  was routed image work and failed at the provider. The guard, and the matrix,
  now ask the adapter's own surface as well.

### MCP inside a live agent run

Previously listed as unverified because it needed an MCP server and a model in
one run. A dependency-free MCP server now lives in the repository
(`scripts/local-mcp-server.mjs`), so the join is exercised end to end: the
server is registered and assigned to a workspace, its tools reach a real model
through the real tool-selection path, and the model's call is answered by the
server itself.

### Provider reachability

Two provider APIs are reachable from this environment. Neither can generate
anything without a key, but an unauthenticated request still proves the
adapter's URL, method and headers reach the real service, that the body is
well-formed enough to get as far as the credential check, and that the resulting
error is classified correctly. That is how the Google defect was found.

---

## What was verified, and how

Everything in this table was executed. Nothing is inferred from a reading of the
code.

| Claim | How it was proved |
| --- | --- |
| One caller's revoked key does not open the provider's breaker | Two users, one bad key, a real socket; the other user's call still served. The counterfactual is asserted in the same test, so it cannot quietly stop meaning anything |
| A provider 503 lands on the provider and not on the account | Same suite; the account keeps a null cooldown and stays available |
| An anonymous 429 still lands on the provider | Same suite; there is no account to blame |
| A cooling-down account is skipped and recovers on its own | Deterministic clock; the spare key is chosen, then the primary returns |
| A routing rejection says "busy" rather than "not configured" | Router preview asserts the reason text |
| Quota is read off a real response | The mock provider publishes headers; limit, remainder and source all arrive |
| Nothing is recorded when a provider publishes nothing | Asserted empty — silence is not plenty |
| A spent window that has reset stops applying | Clock advanced past the reset; the account returns |
| Account standing survives a restart | A second `App` over the same directory: state, live cooldown and allowance all come back |
| Quota reaches an account through the whole gateway | Real gateway, real socket, real credential, real headers; the remainder comes back through `/api/credentials` |
| A usage row names the step that produced it | A real agent run: every row's `step_id` matches a step in the task |
| The routing decision survives the request | Same run; the snapshot carries the applied mode and the summary |
| A request id can be traded for what happened | `/api/trace/:id` leads back to the task; an unknown id is a 404, not an empty trace |
| Two runs of one role are told apart | Store-level, asserting both halves: role matching returns two, step matching returns one |
| The matrix separates ceiling from evidence | The sim can execute chat and embeddings and not video; `text` reads `probe_verified`; no provider claims evidence for a modality it cannot execute |
| The trace panel renders and says the policy | Chromium, driving the real screen: a call is served, selected, and the request id shown exactly as issued |
| The matrix tab labels both halves | Chromium, same suite |
| MCP tools reach a real model | A real MCP server over stdio, assigned to a workspace, its answer recorded in the task's tool calls |
| An adapter reaches the real Anthropic API | Unauthenticated; a typed `authentication_failed`, and the fake key never survives into the error |
| Google's 400 is an auth failure | Unauthenticated against the live API; red before the fix |
| A real provider's auth failure lands on the account | Same suite, provider breaker still closed |
| The UI suite tests the sources | Found by writing a test for markup that was not in the bundle; the suite now rebuilds when `apps/web/src` or `packages/ui/src` is newer |
| A modality the adapter would refuse is refused up front | Red-then-green: the guard asked only whether a method existed, and the OpenAI-compatible base defines every method and refuses at call time, so the guarantee held only for adapters that omit methods outright |

**Suites:** unit 306, router 90, contract 24, integration 27, e2e 105, chaos 12,
UI 30. **594 tests, 583 passing, 0 failures, 11 skipped** (10 Docker, 1 no X
display).

---

## What is not verified, and why

Stated plainly rather than rounded up.

| Not verified | Reason |
| --- | --- |
| Nine of the eleven hosted adapters | The egress policy reaches `api.anthropic.com` and `generativelanguage.googleapis.com` and nothing else. Groq, OpenAI, OpenRouter, Mistral, DeepSeek, Together, Cohere, HuggingFace, Cloudflare, Replicate, fal, Pollinations and AI Horde were all refused at CONNECT |
| Any authenticated provider call | No credential exists here, and fabricating or guessing one is out of bounds. Capability behaviour on hosted providers stays unverified |
| Quota against a real provider's headers | Verified against a real socket and through the whole gateway, but the headers are the local server's. No reachable provider will publish real ones without a key |
| Docker sandbox, dev containers, isolated test runner | The Docker daemon is not reachable in this environment. Ten tests skip, each naming the reason |
| Desktop computer-use | No X display |
| Lightpanda and remote-CDP browser engines | No binary or endpoint has ever been available here |
| Prompt caching | Nothing emits `cache_control`; the cached-token counts providers return are still parsed and discarded |

None of these is described anywhere in the product as working.

---

## Security review of this pass

Against the constraints set for it.

- **Secret leakage.** The rate-limit sink reads headers only, never the body or
  the request. `credential_health.last_error` is redacted and truncated before
  it is stored, so a provider that echoes a key fragment into an error cannot
  make Meridian's own tables a second place it leaks from. Both live-provider
  tests assert the probe key never survives into an error message or its
  details. No credential is returned by any new route.
- **Cross-user state leakage.** The account fix *reduces* it: one caller's key
  state no longer changes another caller's routing. `/api/trace/:requestId` is
  scoped exactly like `/api/usage` — a request id is guessable enough that
  trading one for another person's model, workspace and spend would be a
  disclosure, so a non-admin sees only their own rows and an unknown id is
  indistinguishable from someone else's. `/api/credentials` health rows are
  filtered to the credentials the caller may already see, adding no reach.
  `reset-health` is owner-gated like every other write to a credential.
- **No credential impersonation.** The live-provider tests use an unmistakably
  fake key and take one request per provider per run. Nothing searches for,
  infers, reuses or works around a credential, and nothing attempts to exceed a
  provider's limits.
- **Untrusted input.** Rate-limit headers are provider-controlled: every field
  is parsed defensively, a malformed value yields null rather than throwing, and
  the sink is wrapped so observability can never break the call it observes. A
  provider cannot use them to extend its own cooldown beyond the configured
  ceiling.
- **Injection.** No new shell, SQL string interpolation, or file path comes from
  input; the new queries are parameterised like the rest of the store.
- **Nothing generated is committed.** No profiles, caches or credentials.

---

## What I would do next

Ordered by what would matter most.

1. **Prompt caching.** Nothing emits `cache_control`, the cached-token counts
   providers return are parsed and discarded, and `Usage` and `Pricing` have no
   fields for either. The current assembly order also puts the most volatile
   content first, which is backwards for prefix caching.
2. **The gateway chat surfaces.** Context optimisation is wired into the agent
   loop only; the OpenAI and Anthropic surfaces still assemble additively, and
   the three assembly paths are still three.
3. **Per-model health.** The breaker is provider-keyed, so one broken model on a
   healthy provider still cannot be taken out of rotation. Accounts got this
   treatment in this pass; models have not.
4. **Re-verification scheduling.** A claim older than 90 days is discounted, but
   nothing decides when to spend quota re-probing it. That is a policy question
   with a real bill attached.
5. **Probe coverage.** Four capabilities have probes. JSON mode, structured
   output, reasoning, audio and video do not, so they stay at whatever the
   listing or the name gave them.
6. **Review model diversity.** A reviewer's verdict counts; whose verdict it is
   does not. There is still no model-family concept to exclude the implementer's
   own model.
7. **Agent-loop unit tests.** No test constructs an `AgentLoop` or
   `Orchestrator` directly; `ParallelRunner` has none at all.

---

## The standard applied

Nothing here claims a capability the code cannot perform. Where something could
not be exercised, it is listed above with the reason rather than described as
probably fine. Where a document overstated what existed — the hardening report's
provider-coverage count, and its remaining-work list — it was corrected as part
of this pass rather than left to be discovered.
