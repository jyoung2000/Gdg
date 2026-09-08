# The pricing engine

What a call costs, and — the part that decides whether a budget can bind — how
Meridian represents not knowing.

See [PRICING_AND_QUOTA.md](PRICING_AND_QUOTA.md) for the rate card itself: where
the numbers come from, how they are matched, and how a bad upstream publish is
refused. This document is about the arithmetic on top of them.

## The bug this exists to prevent

`computeCost` adds only the rates that are non-null. For a `METERED` model that
publishes no rates, it therefore returned **0** — and the router read that 0 as
a price. Three things followed, all live:

- Under `CHEAP_FIRST` an unpriced model scored **1.0, the maximum** cost score.
  It outranked every model with a real, published, genuinely cheap rate. It won
  *because* nothing was known about it.
- That same 0 was compared against `req.budget`, so an unpriced model **fitted
  every budget ever set**, including a $0.01 one.
- Pools charged 0 against their daily budget, so a **no-spend pool did not stop
  it** either.

This was the failure the earlier pricing work aimed at and missed. `isFree()`
had been taught that an unpublished rate is not a zero one; `computeCost` had
not, and the router reads `computeCost`.

## Cost classes

`packages/shared/src/economics.ts`

| Class | Meaning |
| --- | --- |
| `FREE` | Cannot charge. Structurally free, or every published rate is zero |
| `KNOWN_PAID` | Can charge, and we know how much |
| `UNKNOWN_COST` | Can charge, and **nobody has published how much** |
| `SUBSCRIPTION_INCLUDED` | Declared, and nothing produces it — see below |

`SUBSCRIPTION_INCLUDED` is a named hole rather than a guess. Telling "covered by
a plan I already pay for" apart from "billed per token" needs a provider-specific
entitlement check Meridian does not perform, so nothing constructs it. It exists
because routing has to be able to express it when something can.

Order matters in `costClass`: free is decided first, by `isFree`, which already
refuses to read an unpublished rate as a zero one. So a free model is never
misfiled as unknown and an unknown one is never misfiled as free.

## An estimate carries its own epistemic status

```ts
estimateCall(pricing, { promptTokens, completionTokens }) → {
  usd: number | null,   // null when nothing applicable was published
  known: boolean,       // true only when usd is the whole price
  basis: 'exact' | 'lower_bound' | 'unknown',
  klass: CostClass,
  missing: string[],    // rates the call needed and did not get
}
```

`lower_bound` is the interesting middle: a card publishing an input rate but not
an output rate produces a real number that is a **floor**, not a price. Treating
it as either extreme would be wrong, so it is neither.

A rate counts as *needed* only when the call would be billed at it. An output
rate matters when output tokens are expected; a per-request rate matters when
the call is billed that way, which is what a call with no token counts at all —
an image, a video — is. Treating a null `perRequest` as missing on an ordinary
token call would mark nearly every rate card incomplete and make the
distinction useless.

## Three consequences in the router

**Ranking.** You score on price only if your price is fully known:

```
FREE                    → 1.0
KNOWN_PAID, exact       → log scale
anything else           → 0
```

Not 1.0, which is what `$0` used to earn an unpriced model.

**Limits.** `fitsLimit` returns three answers, and the third is why it exists:
fits, does not fit, or **cannot be shown to fit**. A budget, a per-task cap and
a pool ceiling all treat the third as a refusal, with a reason in those words. A
floor already above the limit is disqualifying too, and says so more usefully
than the generic message.

**Reporting.** `RoutingCandidate.estimatedCost` and
`RoutingDecision.expectedCost` are `number | null`. The UI renders null as
"price unknown", never `$0.00`, and the routing explanation says *"Paid routing
permitted, but the price is unknown"* rather than showing a confident zero.

`TaskEstimate` carries `costKnown`. When false the Director labels the total
"Est. cost (at least)" and flags that a step has no published price — because a
plan the operator approves has to say what it might cost.

## Token accounting

`packages/shared/src/tokens.ts` replaced three divergent character heuristics —
`ceil(len / 3.7)` in two places and a stray `/4` in a third — with one estimator
that counts what actually goes on the wire.

The one that mattered: the router read a message list as
`typeof content === 'string' ? content : ''`, so a request carrying ten
screenshots estimated at **zero prompt tokens**, fitted any window and cleared
any budget. An image is the densest thing a prompt can hold.

Images and audio get a flat per-item figure rather than being measured from the
data URL, whose length is a fact about base64 encoding and not about billing.
Both figures are deliberately mid-to-high: guessing low overflows a window,
guessing high costs a little headroom.

Everything here is an **estimate**. Real accounting always uses the counts the
provider reports back; this exists to answer the questions that have to be
answered before the call.

## Not modelled

- **Cached-input pricing.** The upstream book carries a cached-read rate and
  `computeCost` is strictly flat. Adding one without a cached-token count in
  `UsageRecord` would be a field nothing populates. `Usage` has four fields and
  none of them is a cached-token count.
- **Live quota.** `QuotaState` is defined and correct — `quotaRemainingFraction`
  returns `null`, not `1`, when a provider publishes nothing — and nothing
  constructs one. Free-first routing cannot avoid a route whose daily allowance
  is spent; it finds out by getting a 429.
- **Expected retry and fallback cost.** A route's estimate is for one call. The
  executor's retry budget and fallback chain mean a request can cost more than
  its estimate, and that is not currently folded in.
- **Tiered and threshold pricing.** Providers that change rate above a context
  threshold are billed at their flat rate.
