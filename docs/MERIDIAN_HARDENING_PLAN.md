# Meridian hardening plan

What the [audit](CURRENT_STATE_AUDIT.md) found, in the order it is worth fixing,
with the reasoning for that order.

## The organising principle

Every serious finding is the same bug wearing a different hat: **a missing value
was replaced by a real-looking one.** Unknown price became `$0`. Unverified
capability became a name guess. An operator's "no" became "inferred: yes". A
failed test run became a completed step.

That gives the plan its shape. Work that teaches Meridian to *carry* uncertainty
comes before work that adds capability, because a new feature built on a
confident wrong answer inherits the wrong answer. Concretely: fix the price
before improving the router that reads it; persist capability evidence before
building the prober that produces it; count tokens honestly before optimising
against the count.

## P0 — correctness of what the system already claims

### 1. Cost safety — DONE

Unknown price ranked as cheapest, satisfied every budget, and consumed nothing
from a no-spend pool. Fixed in `packages/shared/src/economics.ts`: a call
estimate now carries its own epistemic status, and a limit that cannot be proven
is a refusal rather than a pass. Multimodal payloads no longer estimate at zero
tokens.

**Done when:** an unpriced model loses to a published expensive one under
`CHEAP_FIRST`; a budgeted request cannot select it at all; the UI says "price
unknown" and never `$0.00`. Nine tests, red against the old code.

### 2. Capability evidence must survive a restart

Today an operator's explicit "this model cannot see images" is erased on reboot
and replaced by a name-heuristic guess that says it can. Nothing else in
verification is worth building until the store can hold a claim.

- Migration `008`: `capability_claims`, `discovered_at`, `last_verified_at` on
  `models`.
- `upsertModels` / `toModel` round-trip them.
- `enrich()` must not let a heuristic overwrite a stronger claim — the merge
  rule already exists in memory and simply needs the persisted input.
- Age the claims: `CapabilityClaim.at` is written everywhere and compared
  against a clock nowhere.

**Done when:** marking a capability unsupported, restarting, and re-reading it
returns unsupported — proven by a test that boots a second `App` against the
same database file.

### 3. A real capability prober

`probe_verified` is the top of the evidence ranking, the UI already renders
"Verified by a live call", and nothing can ever earn it. Tiny, cheap, per-model
probes that write a real claim — or a definitive `unsupported` on a 4xx that
means "this model does not do that".

Must not: run without credentials, run expensive generations, or crash the
registry when one probe fails.

**Done when:** `pnpm verify:providers` produces `probe_verified` claims against
the local inference server, they persist, and a failed probe degrades that one
capability rather than the process.

### 4. Context optimization core

The largest greenfield item and the one with the clearest measurement. Build the
accounting first (done: `packages/shared/src/tokens.ts`), then a single
assembly seam, then selection.

Order matters here too: **measure, then trim.** A "tokens saved" number computed
by the thing doing the trimming is worth nothing without a real before-count,
and the before-count is what `breakdownTokens` now provides.

Non-negotiable: an explicit user instruction is never optimised away, and
optimisation that costs more than it saves disables itself.

### 5. Regression safety

The suite is the reason any of this is safe to do. Every fix above ships with a
test that fails against the old code — not one that merely passes against the
new.

## P1 — making the control plane real

### 6. MCP tools reach models

`config.mcpServers` is computed on every request and thrown away; there is no
adapter from an MCP tool to a model tool definition. This is the single
highest-value wiring gap in the repository — an entire subsystem that works
end-to-end and is connected to nothing.

It cannot ship without selection: exposing every tool from every enabled server
would put the unbounded tool schemas straight into the context budget that item
4 exists to defend.

### 7. Router reads evidence, not booleans

`router.ts:235` filters on the flat `capabilities` array, so a probe-verified
claim and a 0.5-confidence name guess are indistinguishable to the thing that
actually picks the model. Route on the claim once claims persist.

### 8. Per-model health

The breaker is provider-keyed, so one broken model on a healthy provider cannot
be removed from rotation.

## P2 — capability that depends on the above

### 9. Independent review and escalation

Both halves are missing and neither is expressible today: `AIRequest` has no
exclusion field, and a failed test run is recorded as a completed step. Needs,
in order: detect test failure, let a request exclude a model or family, then
enforce it for the reviewer and escalate on repeat failure.

The honesty note matters here — `THIRD_PARTY_NOTICES.md` credited an upstream
with this concept as though it were built. Corrected.

### 10. Browser backend arbitration and SSRF parity

`engine: 'auto'` resolves to the heaviest backend, and the research engine always
spins a full browser then polls hoping content appears. Try HTTP first, escalate
on an empty JS shell. Separately, bring the browser path's DNS guarding to
parity with the HTTP path's, which already defends against rebinding.

### 11. Live quota

Nothing constructs a `QuotaState`. The rate-limit header names are already
carried through as metadata, waiting for a reader.

## P3 — breadth

Dev-container workflows, external agent connections, dashboards. Deliberately
last: none of it is worth having if the numbers underneath are wrong.

## What this plan will not do

- **Rebuild working subsystems.** The executor, breaker, sandbox, credential
  isolation and MCP transport are good. They are extended, not replaced.
- **Claim an upstream's behaviour from having read it.** Concepts get
  reimplemented against Meridian's interfaces or recorded as gaps.
- **Report a capability as verified because the code for it exists.** Anything
  that cannot be exercised in this environment stays
  `IMPLEMENTED_BUT_UNVERIFIED` and says why.
