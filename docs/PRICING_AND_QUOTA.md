# Pricing and quota

What a call costs, how Meridian knows, and — the part that matters most —
what it still does not know.

## The problem this solves

Meridian's shipped catalog carries a pricing **posture** rather than rates.
An entry says `METERED` or `FREE_DAILY`; its `inputPerMTok` and
`outputPerMTok` are `null`. Live discovery fills in real numbers for exactly
one provider, OpenRouter, which publishes them in its own model listing.

For every other paid provider that meant `computeCost` returned **0**. Three
things followed:

- Usage reported `$0` on calls that cost real money.
- Budget caps and pool limits could not bind on spend that always computed to
  zero.
- "Cheapest route" could not compare routes whose price it could not see.

## The price book

`packages/model-sdk/src/sources/litellm-pricing.ts`

Meridian syncs [LiteLLM's model metadata](https://github.com/BerriAI/litellm)
as a rate card. It is MIT outside that repository's `enterprise/` directory,
and the file sits at the repository root, so it is MIT. Roughly 3,800 entries
across ~130 providers, carrying per-token input and output rates, cached-input
rates, context windows and capability flags.

It is a **price book, not a model list**. It creates no providers and no
models; it fills in rates for models discovery already found. A model Meridian
has never seen gets no entry in the registry just because the book mentions it.

Measured against the live dataset, for a million tokens in and a million out:

| Route | Before | After |
| --- | --- | --- |
| `openai/gpt-4o` | $0.00 | **$12.50** |
| `anthropic/claude-sonnet-4-5` | $0.00 | **$18.00** |
| `groq/llama-3.3-70b-versatile` | $0.00 | **$1.38** |
| `deepseek/deepseek-chat` | $0.00 | **$0.70** |

### Matching is strict, on purpose

The failure mode here is not a missing number, it is a **confident wrong**
one. So a rate is applied only when the entry is about the same model **at the
same provider**, tried in descending order of certainty:

1. the exact upstream key, confirmed to belong to this provider;
2. a provider-qualified key (`groq/llama-3.3-70b-versatile`);
3. a normalised id, **within the same provider only**.

There is no fourth step. An OpenAI model id looked up under Groq returns
nothing rather than attaching one company's rate card to another's bill, and a
provider with no entry in the alias map gets no prices at all. The same weights
genuinely cost different amounts through different hosts.

**OpenRouter is deliberately absent from the alias map.** It publishes real
per-model rates in its own listing and the adapter reads them during discovery;
mapping it here would let a third-party book shadow the provider's own numbers.
Absence from that map is how a provider says "ask me".

### Precedence

```
a rate already carrying real numbers   (the provider's own listing, or a prior lookup)
  → the community price book
    → null — the price stays unknown
```

Unknown is a real outcome and it propagates honestly: the route view shows `—`,
and cheapest-route comparison **excludes** the route rather than treating it as
free and crowning it.

### Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Boot | Reads only the cache. Never waits on GitHub |
| Network down | Serves the last good card with its age |
| 404 body / truncated download | Rejected structurally; cache untouched |
| Well-formed but **shrank by a quarter** | Refused, with the before/after count in the reason |
| Nothing cached, no network | `unavailable` — paid providers report unknown cost, not zero |

The shrink guard exists because a partial upstream publish passes every
structural check and would silently return thousands of models to reporting
`$0`. Growth and ordinary churn are always fine.

## What was NOT broken

Worth being precise, because it is easy to over-claim a fix.

`isFree()` already refused to treat an unpriced metered model as free:

> Unpublished is not the same thing as zero. A metered model whose rates are
> simply unknown can absolutely charge […] Free requires at least one rate
> stated, and every stated rate zero.

So **free-only routing was never unsafe** and `NEVER_PAY` was never bypassed by
the missing rates. The damage was to accounting and comparison, not to the
gate. A test pins both halves.

## Free quotas

`Pricing.freeQuota` has always existed with fields for requests and tokens per
minute and per day. Until now **nothing populated it**, so a tier could be
labelled `FREE_DAILY_QUOTA` with no way to say how large the allowance was.

Two community registries now fill it with real numbers —
`uzair004/awesome-free-llm-apis` publishes limits as structured `rpm`/`rpd`/
`tpd`, and `mnfst/awesome-free-llm-apis` yields them by parsing rate-limit
strings. SambaNova reads `20 req/min, 20 req/day, 200,000 tokens/day` rather
than an adjective.

A rate-limit sentence that cannot be parsed yields **nothing**, not zeroes — a
zero allowance would read as "exhausted".

## Live quota: still a hole

This is the honest part.

`QuotaState` is defined and its helpers are correct — `quotaRemainingFraction()`
returns `null`, not `1`, when a provider publishes nothing, because "we don't
know" and "it's full" must not be the same value to a router choosing a free
route.

But **nothing constructs a `QuotaState`.** No adapter reads remaining quota out
of a response, and the `quotas` table in migration 001 has no reader or writer.
So:

- Meridian knows the *published* size of a free allowance.
- Meridian does **not** know how much of it is left.
- Free-first routing therefore cannot avoid a route whose daily quota is spent;
  it finds out by getting a 429, which the executor handles (`Retry-After`,
  cooldown, breaker, fallback) but which is reactive rather than informed.

`uzair004`'s dataset publishes the rate-limit **header names** for several
providers (`x-ratelimit-remaining-requests` and friends), and Meridian now
carries those through as metadata. They are what the work will need when
someone wires response headers to `QuotaState`. They are stored as metadata and
are **not** presented as live quota.

## Also not modelled

- **Cached-input pricing.** The upstream book carries
  `cache_read_input_token_cost`, and `computeCost` is strictly flat — input,
  output, per-request. Adding a cached-input rate without a cached-token count
  in `UsageRecord` would be a field nothing populates, so it is recorded here
  rather than half-built.
- **Tiered and threshold pricing.** Providers that change rate above a context
  threshold are billed at their flat rate.

## API

| Route | Returns |
| --- | --- |
| `GET /api/catalog/prices` | Rate-card status: source, entries, freshness, licence, how many lookups it served |
| `POST /api/catalog/prices/sync` | Refresh from upstream (admin only — it reaches a third party) |
