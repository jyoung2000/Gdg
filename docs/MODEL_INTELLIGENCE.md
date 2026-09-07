# Model intelligence

What Meridian knows about which models exist, what they cost, how to reach
them — and, deliberately, what it does not know.

The subsystem exists to answer one question well: *what is the best model I can
use right now, and what will it cost me?* Everything below is shaped by the
observation that a wrong answer to that question is expensive in a way a wrong
answer about, say, syntax highlighting is not. Someone acts on "free, no card
required" by handing over their details, or ships a product on a licence that
did not permit it.

So the governing rule is: **an absent fact is a fact.** Unknown is a value, it
is rendered as "unknown", and it never passes a filter that promises the
opposite.

---

## 1. The taxonomy

`packages/shared/src/intelligence.ts`

### Free access is not one thing

`$0 today` covers several different bargains, and collapsing them into a
single FREE badge is the most misleading thing a catalog can do.

| Kind | Meaning |
| --- | --- |
| `FREE_FOREVER` | No charge, no quota that resets |
| `ONGOING_FREE_TIER` | A standing allowance, renewal period unstated |
| `FREE_DAILY_QUOTA` / `FREE_MONTHLY_QUOTA` | Allowance that renews on a known period |
| `TRIAL_CREDIT` | One-off credit. Runs out and does not come back |
| `RECURRING_CREDIT` | Credit granted again each period |
| `PROMOTIONAL_FREE` | Free until the provider ends it |
| `SUBSCRIPTION_INCLUDED` | Covered by a subscription already paid for |
| `DISCOUNTED` | Metered, but below the low-cost threshold |
| `LOCAL_ZERO_API_COST` | Runs on your hardware: no API charge, real electricity |
| `SELF_HOSTED` | You run the weights |
| `PAID_ONLY` | Costs money from the first token |
| `UNKNOWN` | Not established. Never rendered as free |

`ZERO_COST_ACCESS` is the set that costs nothing at the moment of the call.
Note what it excludes: **trial and recurring credit are not in it.** A finite
balance is cheap, not free, and a free-first policy that spent it would be
burning a limited resource the operator may be saving.

### Tri-state, not boolean

```ts
type Tristate = 'yes' | 'no' | 'unknown';
```

Three strings rather than `boolean | null` on purpose. At a call site
`if (reqs.card)` silently treats unknown as false; `reqs.card === 'yes'` forces
the author to decide what unknown means. `AccessRequirements` covers API key,
account, card and phone; `commercialUse` is the same shape.

### Provenance

Every imported fact carries where it came from, which version, when the source
last checked, and a confidence. Confidence for dataset-sourced claims is capped
at `medium` — a third party's reading of a provider's docs on a past date is
good evidence, but it is not Meridian verifying anything. `isStale()` treats an
**undated** claim as stale rather than fresh.

---

## 2. Catalog synchronisation

`packages/model-sdk/src/sources/`

Meridian ships 24 hand-written providers and syncs a much larger set from
[free-llm-api-hub](https://github.com/pacocartones/free-llm-api-hub) (MIT). This
is a synchroniser, not a snapshot: nothing hard-codes a provider, so one added
upstream appears without a Meridian release.

### What a sync does

1. `GET` the dataset, sending the stored `ETag` — a 304 costs upstream nothing.
2. Validate against the upstream schema with zod, **before** touching the cache.
3. Normalise each entry into a `ProviderDescriptor` (when it can back a real
   route) plus `ProviderIntelligence` (always).
4. Diff against the previous payload and report the changes.
5. Register new providers into the `ProviderRegistry`.

### What it refuses to do

An entry becomes a callable provider only when it publishes an
OpenAI-compatible base URL that is usable as-is. Three rejections, all
deliberate:

| Reason | Why |
| --- | --- |
| `already-shipped` | Meridian's hand-written descriptor has a capability table behind it; an import would be a downgrade. The dataset contributes intelligence only |
| `no-openai-compatible-endpoint` | No adapter can honestly serve it. Recorded, not routable |
| `base-url-needs-operator-substitution` | A URL containing `{account_id}` is not an endpoint. Registering it would be "configured but not connected" presented as ready |

On the live dataset (v2.9.0): 69 entries → 28 new routes, 8 enrichments, 33
rejected. Providers 24 → 52.

### Failure behaviour

This is most of the value, so it is tested hardest:

| Situation | Behaviour |
| --- | --- |
| Boot | Reads **only the cache**. Never waits on a third-party host to start |
| Network down | Serves the last good catalog, `fromCache: true`, with `cacheAgeDays` |
| Malformed upstream | Rejected at validation; the good cache is **not** overwritten |
| Nothing cached, no network | `status: 'unavailable'`, no providers invented |
| Upstream adds a field | Passes through; a new column never strands the operator |

The UI leads with this state. A sync that failed today must not look like one
that succeeded.

### Change detection

Field-by-field rather than a JSON diff, so changes read as sentences a person
would act on — "Google Gemini: card requirement is now true". Changes are
marked `significant` when they alter whether someone can use a provider
(a free tier vanishing, a card appearing, an endpoint moving) and not when
prose is reworded.

---

## 3. Routes

`packages/model-sdk/src/routes.ts`

A model is not a price. The same weights are served by many providers, so
"which model" and "through whom" are separate questions.

`groupRoutes()` collapses `provider:model` pairs into one group per model.
Identity is conservative: publisher prefixes, casing and packaging suffixes
(`:free`, `-fp8`, `-awq`) are normalised away; **version dots and `-instruct`
are not**, because merging two genuinely different models would route a request
somewhere the caller did not choose. Two models shown as two groups is a
cosmetic flaw; two models merged into one is a correctness bug.

Each group reports `cheapest`, `fastest`, `freeRoute` and `localRoute`, and each
refuses to guess:

- **Cheapest** considers only routes with a published price. A `null` rate is
  not zero. A group where nobody publishes a price reports `cheapest: null`
  rather than crowning an unknown-cost route.
- **Fastest** considers only measured routes.
- **Free** prefers a route that is actually configured over one that would need
  a key.

Price comparison uses a blended rate at 3:1 input:output — an assumption, named
in the code rather than hidden, because comparing input rates alone rewards
providers that load cost onto output.

---

## 4. The free radar

`freeRadar()` ranks zero-cost options by

```
0.40 quality + 0.25 reliability + 0.25 availability + 0.10 speed
```

with two honesty constraints. Trial credit never appears. And a model that has
never been exercised scores from a **neutral prior** (0.75), not a flattering
one, so nothing climbs the list merely by never having been tried.

Every entry carries its `factors`, and the UI shows them. A ranking whose
reasoning is hidden is a ranking the user cannot argue with.

---

## 5. Health and measurement

`packages/model-sdk/src/scoring.ts` computes, from a rolling 100-sample window
of **real usage rows** (every completed call, not synthetic probes and not only
the rare task someone rated):

| Signal | How |
| --- | --- |
| `latencyMs` | EWMA of observed latency |
| `p95LatencyMs` | Nearest-rank 95th percentile — **null below 21 samples** |
| `jitterMs` | Standard deviation across the window |
| `uptime` | EWMA of success |
| `stability` | Observed successes / attempts |

### Why p95 has a floor

Nearest-rank picks `sorted[floor(n * 0.95)]`, and for any **n ≤ 20 that is the
last index** — the maximum, wearing a percentile's name. A "p95" from ten calls
is the slowest of the ten, which systematically overstates tail latency.
`percentile()` returns `null` below `MIN_SAMPLES_FOR_P95`, so the value only
appears once it means what it says. Observed live: at 10 samples p95 is `null`
while jitter and mean latency are already real; at 22 samples p95 appears.

### Benchmarks do not overwrite traffic

A manual benchmark is seven cases. It cannot produce a 95th percentile, its
spread is across prompts of deliberately different lengths (200–700 max tokens)
rather than repeated calls, and a single run's pass rate has no time dimension
and so is not uptime. The benchmark path therefore reports `null` for p95 and
jitter, and the gateway **carries forward** the traffic-derived p95, jitter,
uptime and stability rather than replacing them. Running a benchmark must not
degrade the numbers routing depends on.

`ProviderHealth` carries a circuit breaker (`closed` / `open` / `half_open`)
with cooldown, consecutive failures and a rolling error rate.

---

## 6. Known gaps

A multi-agent audit of this subsystem and its neighbours found the following.
They are listed rather than quietly left, because a catalogue that hides its own
holes is doing the same thing as one that calls trial credit free.

### Quota is a typed hole

`QuotaState` is defined and its helpers are honest — `quotaRemainingFraction()`
returns `null`, not `1`, when a provider publishes nothing, because "we don't
know" and "it's full" must not be the same value to a router choosing a free
route. But **nothing constructs a `QuotaState`.** No adapter reads quota from
response headers, and the `quotas` table in migration 001 is dead schema with no
reader or writer. Live remaining-quota is therefore always unknown.

### Free allowances are not counted

`FREE_DAILY` and `FREE_MONTHLY` sit inside `NON_SPENDING_PRICING`, so `isFree()`
is permanently true for them and `estimateCost()` returns 0 forever. There is no
allowance accounting: a model on a 250-request daily quota is treated as free on
request 251 exactly as on request 1. Meridian will not overspend *money* on it,
but it cannot tell you the allowance is gone.

### FREE_FIRST is a weight, not a gate

`FREE_FIRST` is absent from `STRICTLY_FREE_MODES`, so it applies a 0.42 bonus to
free candidates rather than exhausting free capacity before considering paid.
`FREE` and `LOCAL` do gate. The mode's description overstates what it enforces.

### Provider rate limits are declared and unread

`ProviderDescriptor.rateLimits` (requests/minute, tokens/minute, requests/day)
is populated by the catalog and read by nothing. Published limits do not
influence routing.

### Intelligence is not in the database

`ProviderIntelligence` lives in memory and is rebuilt at boot from the on-disk
sync cache, so it survives a restart — but there is no `provider_intelligence`
table, and it cannot be queried with SQL or joined against usage.

### Model status is always "unknown"

`ModelRegistry.setStatus()` is never called, so the `status` field on both the
OpenAI-compatible model list and the admin model list is the literal string
`"unknown"` for every model, always.

### Not persisted across restart

`upsertModels` writes 14 columns and silently drops `capabilityClaims`,
`discoveredAt` and `lastVerifiedAt`. An operator confirming a model's
capabilities has that confirmation lost on restart.

### Paid spend is reported as $0

The most consequential finding, and it undercuts every cost comparison above.
Every price in the shipped catalog is `null` — the entries carry a pricing
*posture* (`METERED`, `FREE_DAILY`) and no rates. Live discovery fills in real
rates for exactly one provider, OpenRouter, which publishes them in its model
listing. For everyone else — Anthropic, OpenAI, fal, Replicate — `computeCost`
therefore returns **0**, so usage reports $0 spend on calls that cost real
money, and there is no route or file through which an operator can supply
rates.

Two consequences worth stating plainly. Budget caps and pool limits cannot bind
on providers whose spend always computes to zero. And `blendedPerMTok` in route
comparison returns `null` for those providers, which is why "—" appears where a
price should be: the route view is honest about not knowing, but it is not
comparing what it cannot see.

### Two providers can never be routed

Cloudflare Workers AI and fal.ai declare `supportsDiscovery: false` and
implement no `listModels`. Their code comments say their models come from "the
static catalog" — and no such static model catalog exists. Both providers are
registered, can hold a credential, and will never have a model to route to.

---

## 7. API

| Route | Returns |
| --- | --- |
| `GET /api/catalog/status` | Sync state, version, freshness, counts, licence, attribution |
| `POST /api/catalog/sync` | Force a refresh (admin only — it reaches a third-party host) |
| `GET /api/catalog/intelligence` | Access terms per provider. `?free` `?noCard` `?commercial` |
| `GET /api/catalog/changes` | What changed at the last sync, significant first |
| `GET /api/routes` | Route groups. `?multiOnly` `?q` `?limit` |
| `GET /api/routes/:key` | Every route for one model |
| `GET /api/radar/free` | Best free options now. `?includeUnconfigured` `?limit` |

The filters match only what is **confirmed**. `?noCard=true` returns the 59
providers confirmed card-free, not the 62 you get by treating the 3 unconfirmed
ones as a yes. That difference is the whole point.

---

## 8. Where it appears

The **Discover** screen (Infrastructure → Discover) has three tabs — free radar,
routes, provider terms — over a banner that leads with where the catalog came
from and how old it is.

## Tests

`tests/unit/model-intelligence.test.ts` and `tests/unit/routes.test.ts`. Most of
them are negative: that unknown does not become no, that trial credit is not
free, that an unpriced route does not win cheapest, that a malformed payload
does not destroy the cache, and that a failed sync does not empty the catalog.
