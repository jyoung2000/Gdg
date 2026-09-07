# Upstream integration matrix

What was taken from each upstream project, what was deliberately left, and what
Meridian already had before any of them were read.

The last of those turned out to matter most. Meridian was not a model list
waiting for a routing engine: the router, the policy modes, the retry and
circuit-breaker layer and the latency measurement were already built and
working. Reimplementing them from an upstream design would have been a
destructive rewrite of code that passes its tests. So this exercise was mostly
**one real integration** — a live catalog of free providers, which Meridian
genuinely lacked — plus an audit that confirmed the rest was already there.

Recording that honestly is the point. A matrix that claimed five integrations
where there was one would be the same kind of lie as a catalog that calls trial
credit free.

---

## Summary

| Upstream | Licence | Outcome |
| --- | --- | --- |
| [free-llm-api-hub](https://github.com/pacocartones/free-llm-api-hub) | MIT | **Integrated.** Live dataset sync — 69 providers, 28 new callable routes |
| [free-coding-models](https://github.com/vava-nessa/free-coding-models) | MIT | **Already present.** Health/latency measurement existed; concept confirmed |
| [free-claude-code](https://github.com/itspsr/free-claude-code) | MIT | **Already present.** Provider rotation and fallback existed |
| [Codebuff / freebuff](https://github.com/CodebuffAI/codebuff) | Apache-2.0 | **Partially present.** Agent pools existed; per-task model routing existed |
| [cheapestinference/*](https://github.com/cheapestinference) | MIT (3 repos) | **Already present.** Retry, backoff, `Retry-After`, circuit breaker existed |
| cheapestinference/examples | **none** | **Excluded.** No licence — nothing copied or adapted |

No source code was copied from any upstream repository. The one thing
redistributed is the free-llm-api-hub dataset, which MIT permits; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

---

## 1. free-llm-api-hub — the real integration

**Licence:** MIT (Copyright 2026 Paco Cartones). One LICENSE file, standard
unmodified MIT text; `package.json` and `CITATION.cff` both declare MIT. There
is no separate data licence — no CC-BY, no ODbL, no dual grant — so the MIT
grant covers `data/providers.json` along with the code, and the repository's own
README says so explicitly. Redistribution is permitted; the only obligation is
retaining the copyright notice, which
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) reproduces in full.

**What it is:** a curated, versioned, machine-readable dataset of providers with
free tiers or trial credit, carrying the fine print catalogs normally omit —
card and phone requirements, commercial-use permission, OpenAI-compatible base
URLs, and a per-entry verification date.

**What Meridian does with it**

| Upstream field | Becomes | Notes |
| --- | --- | --- |
| `slug`, `name` | `ProviderDescriptor.id` / `.name` | |
| `free_type` | `FreeAccessKind` | `renewing-quota` resolves to daily/monthly by reading the published limits, or stays a generic ongoing tier when no period is stated |
| `free_tier`, `rate_limits`, `notes` | `ProviderIntelligence` summaries | Kept as prose; providers do not express limits uniformly |
| `card_required`, `phone_required` | `AccessRequirements` (tri-state) | `null` → `'unknown'`, never `'no'` |
| `commercial_ok` | `DataUsePolicy.commercialUse` | `null` → `'unknown'` |
| `openai_compatible` + `openai_base_url` | `adapter: 'openai-compatible'`, `baseUrl` | The one adapter this data can honestly back |
| `env_key` | `ProviderDescriptor.envKeys` | Credential discovery finds it automatically |
| `modalities` | `ProviderKind[]` | Conservative mapping |
| `verified`, `last_verified`, dataset `version` | `Provenance` | Confidence is capped at `medium`; never `high` |

**Measured result** against the real upstream (v2.9.0, generated 2026-08-14):

```
69 entries
 28  registered as new callable providers
  8  enriched providers Meridian already ships
  1  rejected: base URL needs operator substitution ({account_id})
 32  rejected: no OpenAI-compatible endpoint
```

Provider count went from 24 to 52 on a live sync.

**Where it lives:** `packages/model-sdk/src/sources/free-llm-api-hub.ts`
(schema, classification, normalisation), `sources/sync.ts` (fetch, ETag cache,
offline fallback, change detection), `apps/gateway/src/services/catalog-sync.ts`
(registration into the provider registry).

**What was NOT taken:** the repository's site, badges, README generators and
probe scripts. Meridian syncs the dataset, not the project around it.

---

## 2. free-coding-models — concept confirmed, already implemented

**Licence:** MIT.

**The concept worth having:** measure provider health continuously instead of
trusting static claims — latency distribution, jitter, uptime — and rank on
what was observed.

**Meridian already did this.** `packages/model-sdk/src/scoring.ts` computes,
from a rolling 100-sample window of real usage rows:

- `p95LatencyMs` — the 95th percentile of a sorted window, not an average
- `jitterMs` — the standard deviation (`Math.sqrt(variance)`)
- `uptime` — an exponentially weighted moving average of success
- `stability` — observed successes over attempts

fed from `App.recordUsage` in `apps/gateway/src/services/app.ts`, i.e. from
every real call rather than a synthetic probe.

**Consequence:** nothing to port. A "Stability Score" reimplementation would
have replaced a working, tested measurement with a differently-shaped one.
Meridian's `freeRadar` exposes these numbers with the factors broken out, which
is the same idea reaching the user.

---

## 3. free-claude-code — concept confirmed, already implemented

**Licence:** MIT.

**The concept worth having:** a user should not lose a task because one
provider returned an error; rotate to another configured model.

**Meridian already did this.** `packages/routing-sdk/src/executor.ts` builds a
fallback chain from the router's ranked candidates and walks it, with a retry
budget shared across the whole chain so a request cannot bounce indefinitely.
Errors carry `retryable` and `failover` flags from a taxonomy, so a bad API key
fails fast instead of being retried against the same provider.

**Consequence:** nothing to port.

---

## 4. Codebuff / freebuff — partially present

**Licence:** Apache-2.0, "Copyright 2025 Freebuff, Inc.", with a `NOTICE` file.
Not copied, so the Apache-2.0 obligations (propagating NOTICE, stating changes)
do not arise.

Worth recording because it is easy to double-count: **the two repositories are
byte-identical.** `CodebuffAI/freebuff` and `CodebuffAI/codebuff` are two
remotes publishing the same public snapshot of one private monorepo (both at
commit `f41e975`; `diff -rq` excluding `.git` returns nothing). They are one
codebase, not two sources that happen to agree.

**The concept worth having:** specialised agents with per-task model selection,
and reviewing with a different model family from the one that implemented.

**Meridian already has** agent roles with per-role task types and preferred
routing modes (surfaced in the vocabulary endpoint's `agents` array), inference
pools (`BUILTIN_POOLS`), and a router that takes `taskType` into account when
scoring.

**Not implemented:** an enforced "review with a different family than the
implementer" rule. Meridian can be configured that way through pools, but does
not require it. Recorded here as a gap rather than claimed.

---

## 5. cheapestinference — concept confirmed, already implemented

**Licences:** MIT for `claude-auto-retry`, `openclaw-plugin-ratelimit-retry` and
`silos`. **`examples` carries no licence file** and was therefore excluded
entirely — no code, config or data from it was read into Meridian.

**The concept worth having:** honour `Retry-After`, back off exponentially with
jitter, bound the retry budget, and trip a breaker rather than hammering a
provider that is down.

**Meridian already did all of it:**

| Behaviour | Where |
| --- | --- |
| `Retry-After` honoured | `executor.ts` — `err.retryAfterSec != null ? min(retryAfterSec*1000, 10s) : backoff(...)` |
| Full-jitter exponential backoff | `packages/shared/src/time.ts` — `rand() * min(cap, base * 2**attempt)` |
| Bounded retry budget | `executor.ts` — shared across the whole fallback chain |
| Same-target retry cap | `executor.ts` — at most two tries before moving on |
| Circuit breaker | `packages/routing-sdk/src/health.ts` — `closed` / `open` / `half_open` with cooldown |
| Non-retryable errors fail fast | the error taxonomy's `retryable` / `failover` flags |

**Consequence:** nothing to port.

---

## Round 2 — pricing, registries and routing conventions

A second pass added more upstreams. Same rules: integration is claimed only
where something real ships, and an upstream that could not be inspected is
recorded as exactly that.

| Upstream | Licence | Outcome |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | MIT except `enterprise/` | **Integrated (data).** `model_prices_and_context_window.json` synced as a rate card — ~3,800 entries. No code taken |
| [mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) | CC0-1.0 | **Integrated (data).** Model listings + parsed rate-limit strings, at `UNVERIFIED` confidence |
| [uzair004/awesome-free-llm-apis](https://github.com/uzair004/awesome-free-llm-apis) | CC0-1.0 | **Integrated (data).** Structured free-tier limits (`rpm`/`rpd`/`tpd`), access terms, rate-limit header names |
| [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | inspected | **Concepts.** Alias-style model selection informed `meridian/*` aliases; its session affinity is recorded below as a gap, not claimed |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | inspected | **Concepts.** Per-mode/per-role model preferences; Meridian's per-role `taskType` + `preferredMode` already covered the shape |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | — | **NOT inspected.** The inspection run failed before reading the repository; no findings exist and none are invented |
| [block/goose](https://github.com/block/goose) | — | **NOT inspected.** Same — recorded as an honest gap |

**LiteLLM specifics.** The licence carve-out matters: everything under
`enterprise/` is excluded from the MIT grant, and `litellm/proxy/enterprise` is
a symlink into that directory. Meridian takes exactly one root-level file, as a
runtime-fetched rate card with an anti-shrink guard
(`packages/model-sdk/src/sources/litellm-pricing.ts`, `price-book-sync.ts`);
matching is same-provider-only so one company's rates are never attached to
another's bill. Details in [PRICING_AND_QUOTA.md](PRICING_AND_QUOTA.md).

**What round 2 shipped in code** (Meridian's own, no upstream code copied):
the price book and its sync; the `DiscoverySource` metadata/confidence/
precedence contract; the two community-registry importers; dynamic
`meridian/*` aliases resolved at the OpenAI surface; an explicit-preference
tier in the router; and honest p95 (`null` below 21 samples rather than a
max masquerading as a percentile).

**Round-2 gaps, recorded rather than claimed:**

- **Session affinity** (Kilo has it): pinning a conversation to the provider
  that served its earlier turns. Meridian routes each call independently.
- **hermes-agent and goose** were not read; any overlap or divergence with
  them is unknown.
- **freeinference.dev** publishes a registry this environment's egress
  allowlist cannot reach; no importer was written against an unseen schema.

---

## What this exercise actually added

1. A live, self-updating catalog of free and trial providers, with provenance
   and change detection — Meridian had no equivalent.
2. A free-access taxonomy that distinguishes a perpetual free tier from a
   renewing quota from a one-off trial credit, and a tri-state for access
   requirements and commercial use.
3. Route comparison: the same model grouped across providers, with cheapest,
   fastest, free and local computed without guessing at absent data.
4. A Discover screen and a free-model radar that show the factors behind every
   ranking.

## What it did not add, and why

- **Live provider benchmarking from this environment.** The network allowlist
  here reaches github.com but not provider APIs, so no free-tier endpoint could
  be called to verify a claim end to end. The measurement code is real and
  exercised against a local server; verification against a hosted free tier is
  the operator's to run.
- **Quota introspection.** `QuotaState` exists and is honest — every field is
  nullable and `quotaRemainingFraction` returns `null` rather than `1` when a
  provider publishes nothing — but no provider adapter currently populates it
  from response headers. It is a typed hole, not a filled one.
- **Subscription-backed access.** Distinguishing "included in a subscription I
  already pay for" from API billing requires provider-specific entitlement
  checks that none of the upstreams solve either. `SUBSCRIPTION_INCLUDED` exists
  in the taxonomy and nothing currently produces it.
