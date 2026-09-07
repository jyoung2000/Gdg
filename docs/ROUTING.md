# Routing

## The two phases

**Phase one — hard constraints.** Every model that *cannot* serve the request
is removed, each with a recorded reason:

- Wrong modality, or missing a required capability (`tools`, `vision`,
  `reasoning`, `embedding`, …).
- Context window smaller than required.
- No adapter for the provider, or the adapter does not implement this modality.
  This is what makes "no fake support" structural: a provider without an
  `image` method cannot be routed image work.
- Provider circuit is open (already known to be failing).
- Provider trust level not permitted by the privacy mode, or the request is
  marked `sensitive` and the provider is not verified or trusted.
- Not local when the request or the mode is local-only.
- Can charge money when paid routing is not permitted, or the estimate exceeds
  the request budget or the user's per-task cap.
- The pool is at its concurrency limit, or the call would breach its budget.
- No credential is configured.

Nothing that survives phase one is a wrong answer.

**Phase two — scoring.** Survivors are scored on seven factors, weighted by
mode:

| Factor | Meaning |
| --- | --- |
| quality | Measured score for this task type, shrunk toward neutral until enough samples exist |
| speed | Inverse latency; unmeasured models sit mid-pack so they get sampled rather than starved |
| cost | Inverse estimated cost, on a log scale |
| free | Bonus for a model that cannot charge |
| local | Bonus for your own hardware |
| preference | Your saved model and provider preferences, and pool member priority |
| reliability | Measured stability × (1 − recent provider error rate) |

## Modes

Six plain-language modes are the primary control:

| Mode | Optimises for |
| --- | --- |
| `AUTO` | Balanced, free-leaning. The default |
| `BEST` | Highest measured quality |
| `FAST` | Lowest latency |
| `CHEAP` | Lowest cost per call |
| `FREE` | Only models that cannot charge |
| `LOCAL` | Only your own hardware |

Nine explicit policies sit behind "Advanced": `FREE_FIRST`, `CHEAP_FIRST`,
`QUALITY_FIRST`, `FASTEST`, `LOCAL_FIRST`, `USER_FIRST`, `ADMIN_FIRST`,
`BALANCED`, `CUSTOM`.

`FREE`, `LOCAL` and `LOCAL_FIRST` are **hard** constraints, not preferences: a
paid model is removed in phase one, never merely outranked.

## Model aliases

Any OpenAI-compatible client can ask for a routing intent instead of a model
name. Send one of these as `model` and the router picks the concrete route at
request time; the response's `meridian` block names what was actually used.

| Alias | Resolves to |
| --- | --- |
| `meridian/auto` | Balanced choice — quality, cost, speed, availability. Also answers to bare `auto`, `meridian` and `default` |
| `meridian/free` | Best route that cannot charge. Never trial credit |
| `meridian/cheapest` | Lowest expected cost among routes that can serve the request |
| `meridian/best-value` | Best balance of quality, reliability and cost |
| `meridian/frontier` | Highest measured quality, cost notwithstanding |
| `meridian/fastest` | Lowest measured latency among healthy routes |
| `meridian/local` | Only models on this machine. Nothing leaves it |
| `meridian/free-coder` | Best free model for writing and changing code |
| `meridian/free-reasoning` | Best free model for multi-step reasoning |
| `meridian/free-vision` | Best free model that can actually see an image |
| `meridian/free-image` | Best free route for generating an image |

Three properties keep aliases honest:

- **They cannot spend.** An alias sets the routing mode and constraints only —
  never `allowPaid`, a budget, or a pinned provider. `meridian/free` and the
  `free-*` aliases are hard free-only constraints, and cost gates apply to an
  alias request exactly as to a named model.
- **They fail loudly.** An unknown `meridian/…` name is an error listing the
  aliases that exist, not a silent fall-through to `auto`.
- **They are listed.** `GET /v1/models` returns them first, marked
  `meridian.alias: true`, so a client can discover them the same way it
  discovers models. Explicit `meridian` request extensions override whatever
  an alias implies.

## The fallback chain

The chain deliberately prefers a **different provider** first. If the first
choice failed because its provider is rate limited, the second-best model on
that same provider will fail identically. Same-provider alternates fill the
remaining slots.

Errors are classified once, in `packages/shared/src/errors.ts`, and each code
carries whether it is worth retrying, worth failing over, and how long to cool
the provider down:

| Code | Retry same | Try next | Cooldown |
| --- | --- | --- | --- |
| `rate_limited` | yes | yes | 30s, or the provider's `Retry-After` |
| `timeout` | yes | yes | 10s |
| `server_error` | yes | yes | 20s |
| `quota_exhausted` | no | yes | 15m |
| `authentication_failed` | no | yes | 10m |
| `model_unavailable` | no | yes | 5m |
| `content_filtered` | no | **no** | — |
| `invalid_request` | no | **no** | — |
| `budget_exceeded` | no | **no** | — |

A content filter or a malformed request is not fixed by asking a different
model, so the chain stops rather than burning the budget.

The **retry budget is shared** across the whole chain: three attempts means
three attempts total, whether they land on one provider or three.

## The circuit breaker

Three consecutive failures open a provider's circuit; a non-retryable error
opens it immediately. While open the provider is not a candidate at all, so a
failing provider costs one request rather than one per call. After the cooldown
it goes half-open and a single success probe is tried; two successes close it,
one failure re-opens it with an escalated cooldown.

Reliability scoring means traffic usually moves away from a degraded provider
*before* the breaker trips — the error rate lowers its score after the first
failed round.

## Pools

A pool is a **routing policy**, not a list of models. Its strategy overrides
the caller's mode, because choosing a pool is choosing a policy.

Eleven built-ins: `core`, `balanced`, `frontier`, `flagship`, `fast`, `coding`,
`reasoning`, `vision`, `image`, `video`, `local`.

Each has members with priorities, a fallback pool, a concurrency ceiling and a
daily budget. A budget of `0` makes it a no-spend pool: any call that would cost
money is refused. An empty member list means "any model the strategy selects",
so a new pool is not a dead end.

## Reservations

A reservation grants a pool extra concurrency and its own budget for a fixed
window, optionally restricted to specific models. Inside the window the
reservation's limits apply; outside it, nothing changes.

Capacity is only ever described as unlimited when the pool genuinely has no
ceiling.

## Economics

| Kind | Meaning |
| --- | --- |
| `FREE` | Genuinely free, no allowance |
| `FREE_DAILY` / `FREE_MONTHLY` | A rate-limited allowance, not unlimited capacity |
| `TRIAL` | Trial credit. **Expires** — never shown as "Free" |
| `CREDIT` | Promotional credit. **Expires** |
| `FLAT` | Flat rate |
| `RESERVATION` | Reserved capacity |
| `METERED` | Per-token or per-request |
| `LOCAL` | Your hardware |
| `PAID` | Paid |
| `UNKNOWN` | Unknown, and treated as chargeable — guessing "free" would let a request spend money without permission |

## Before you commit

`POST /api/routing/preview` runs the full selection and executes nothing. It
returns the decision, the ranked candidates with their per-factor scores, and
every rejection with the rule that caused it.

`POST /api/tasks/estimate` does the same for a whole agent task: it asks the
router what it would choose for each step and sums the result, so
"$0.00, free capacity available" means the router genuinely found free capacity
for every step.
