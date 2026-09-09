# The free-inference discovery engine

What free inference exists, where the claim came from, and how much to trust it.

---

## The problem it solves

"Which models can I use for nothing?" is easy to answer badly. There are
dozens of lists, they disagree, most entries have no date on them, and the word
*free* covers at least five different things — a perpetual tier, a daily quota,
a one-off credit, a promotion that ended last month, and a model that runs on
your own GPU.

An answer that flattens those into one word is worse than no answer, because it
is confidently wrong in the direction that costs money.

So this engine does four things, in order: **collect** from many sources,
**merge** them under an explicit precedence, **rank** what survives, and
**show the evidence** for every claim it kept.

---

## Sources

A source is a plugin (`DiscoverySource` in
`packages/model-sdk/src/sources/types.ts`). It declares what it is authoritative
about, and it may contribute nothing else.

| Source | Class | Contributes | Verified live? |
| --- | --- | --- | --- |
| `free-llm-api-hub` | verified-dataset | providers, models, access terms, pricing, quota | **yes** |
| `awesome-free-llm-apis-uzair` | community-catalog | providers, models, limits, capabilities, access terms, quota | **yes** |
| `awesome-free-llm-apis-mnfst` | community-catalog | providers, models, limits, quota | **yes** |
| `openrouter-native` | provider-native | models, pricing, limits, capabilities | no — see below |
| `pollinations-native` | provider-native | models, capabilities | no — see below |
| `huggingface-router` | provider-native | models, limits, capabilities | no — see below |

**"Verified live" means the source has been loaded from its real upstream and
its output inspected.** The three datasets have; the three provider endpoints
have not, because the environment this was built in reaches
`raw.githubusercontent.com` and refuses `openrouter.ai`, `huggingface.co` and
`pollinations.ai` at CONNECT. What is proved for those three is the parsing,
against captured response shapes, and the behaviour when a response is not what
was expected — `tests/unit/discovery-native.test.ts`. What is **not** proved is
that the live endpoints answer in the shape the parsers expect. Anyone with
network access can settle it in one command:

```bash
curl -s https://openrouter.ai/api/v1/models | head -c 400
```

The parsers are written to degrade rather than throw, so the expected failure
mode of a wrong guess is "this source returned fewer models than usual", not a
boot failure.

### Adding a source

Implement `DiscoverySource`, declare `contributes` honestly, and register it.
Two rules are enforced rather than documented:

- **`load` must not throw.** An unreachable source is a state to report. The
  registry catches a thrown error and turns it into a reportable empty
  snapshot, but a source that relies on that is a source with a bug.
- **`contributes` is checked per field.** A source that supplies a rate while
  declaring only `quota` has that rate dropped, and the drop is counted in
  `refusals` on the status endpoint. This is not pedantry: it is what stops an
  upstream's schema change from silently rewriting another source's data.

---

## Merging

Many sources describe the same provider and the same model. The order of
resolution:

1. **A source may only contribute what it declared.**
2. **Source class beats confidence.** A provider's own API outranks a
   well-maintained dataset, because proximity to the truth beats care taken
   with second-hand information. The order is `user-configured` →
   `live-check` → `provider-native` → `verified-dataset` →
   `community-catalog` → `static-list`.
3. **Within a class, confidence decides** — after age is applied. A claim
   nobody has rechecked in 90 days drops from `LIKELY` to `STALE`.
4. **A tie leaves the incumbent**, so a merge is stable between runs and the UI
   does not flicker between two identical answers.

What this looks like on real data:

```
google-gemini:gemini-2.5-flash   claimed by free-llm-api-hub and mnfst
  pricing         won: free-llm-api-hub   (verified-dataset, LIKELY, 303)
                  overruled: mnfst        (community-catalog, UNVERIFIED, 201)
  contextLength   won: mnfst              — the hub does not publish one
```

Every merged field keeps that record. `GET /api/discovery/providers/:id`
returns it as `origins`, so a wrong answer can be traced to the source that
supplied it.

---

## The word "free"

`FreeAccessKind` has fourteen values and the distinctions are all load-bearing:

| | |
| --- | --- |
| `FREE_FOREVER` | No charge, no quota that resets |
| `ONGOING_FREE_TIER`, `FREE_DAILY_QUOTA`, `FREE_MONTHLY_QUOTA` | An allowance that renews |
| `TRIAL_CREDIT` | A one-off balance. Runs out and does not come back |
| `RECURRING_CREDIT` | A balance granted again each period |
| `PROMOTIONAL_FREE` | Free until the provider ends it |
| `SUBSCRIPTION_INCLUDED` | Money already spent |
| `LOCAL_ZERO_API_COST`, `SELF_HOSTED` | Your hardware, your electricity |
| `PAID_ONLY`, `DISCOUNTED` | Costs money |
| `UNKNOWN` | Not established |

`isZeroCost()` is true for exactly the renewing and local kinds. Credits are
deliberately excluded: the invoice is zero and a finite resource is being spent,
and a "never pay" policy that treated them as free would burn it quietly.

**`UNKNOWN` never renders as free and never satisfies a free filter.** The
repository this data partly comes from is called *awesome-free-llm-apis*. That
is a claim about the list, not about any entry in it, and the difference is a
bill. On live data, 33 of 202 models come out `UNKNOWN` and are excluded, and
the count is shown rather than hidden.

---

## Ranking

`rankFreeInference()` turns the merged catalogue into an order and states the
reason for each position.

| Component | Weight | Why |
| --- | --- | --- |
| Verdict | 1000 | Whether it costs anything is the question being asked |
| Reachability | 80 | Configured here beats theoretical |
| Confidence | ≤100 | How much the claim is worth |
| Freshness | ≤60 | Decays to zero at the 90-day staleness line |
| Quota | ≤40 | Log-scaled; 20 vs 200 a day matters more than 20k vs 200k |
| Corroboration | ≤25 | Two independent sources agreeing is evidence |
| Context | ≤20 | A tiebreak, not a principle |

The verdict scale is `free` 1000, `free-locally` 900,
`free-while-credit-lasts` 400, `paid` 100, **`unknown` 0**.

Unknown ranks below paid on purpose. An unestablished cost is a worse thing to
default to than a known one, because a known price can be budgeted for.

Nothing rewards a model for being *called* free. Everything rewards it for
having evidence attached.

---

## Quota-aware free routing

Discovery that only fills a screen is a catalogue. This is where it changes what
the gateway does.

"Free" as a property of a rate card and "free" as something that will serve
*this* request are different claims. Two free models — one with 900 of 1000
daily requests left and one with 3 — are not equally good choices, and the
router could not tell them apart.

It can now. `RouterDeps.quotaHeadroom` reports the fraction of a provider's
allowance remaining, read from the rate-limit headers providers actually sent on
previous responses (`readRateLimitHeaders` → `recordRateLimit` → per-credential
rows), taking the best across that provider's credentials. Three rules:

- **Unknown headroom is neutral**, neither full nor empty. Most providers
  publish nothing, and penalising them would rank models by how talkative their
  provider's headers are rather than by whether they work.
- **A nearly-spent route is discounted, not eliminated.** It keeps at least a
  fifth of the free weight, so three requests left still beats paying. Paying
  money to avoid a route that still works is the wrong trade.
- **A route with a published zero never reaches scoring.** The credential layer
  rejects it first — *"no requests quota left on this account"* — because that
  layer also knows when the window resets and can put the account back.

So the signal is not "avoid the empty one", which was already handled. It is
"avoid the one about to become empty", which was not: a free-first policy that
keeps picking a nearly-exhausted provider gets a 429, fails over, and repeats,
burning a retry budget on a route it already had the evidence to avoid.

`tests/router/free-quota.test.ts` drives all of this from real response headers
rather than by writing quota rows, so what it proves is that the whole path
exists — headers on a 200, parsed, stored, read by the router — and not just
that the arithmetic is right.

---

## The API

| | |
| --- | --- |
| `GET /api/discovery/status` | Which sources loaded, how old, what was refused |
| `POST /api/discovery/refresh` | Force a refresh (admin) |
| `GET /api/discovery/free` | The ranked list, with `excluded` counts |
| `GET /api/discovery/providers` | Every provider, with its access terms |
| `GET /api/discovery/providers/:id` | One provider, with the merge shown |
| `GET /api/discovery/attribution` | Licence and credit for what is redistributed |

`GET /api/discovery/free` takes `requires` (comma-separated capabilities),
`minContext`, `providerId`, `limit`, and `includeNonFree`.

Every response that is a list also carries **why it is as short as it is**.
"No free models found" and "everything was excluded for reasons you can read"
are different statements, and only one of them is useful.

---

## Refresh, caching and manners

These are free, community-run repositories. A gateway that polls them every
minute is the reason a free thing stops being free.

- **Boot reads the cache and never the network.** A gateway must come up when
  GitHub is down, and come up in the same time either way.
  `tests/e2e/discovery-routes.test.ts` asserts boot makes **zero** outbound
  requests rather than trusting the comment that says so.
- **Every fetch sends `If-None-Match` and `If-Modified-Since`**, so a
  no-change refresh transfers no body.
- **A source is re-read at most every 6 hours**, paced by the same
  `DiscoveryScheduler` the provider discovery uses — minimum interval,
  exponential backoff with jitter, and a pause after repeated failure.
- **A failed refresh keeps serving the last good payload with its age
  attached.** Falling back silently is how stale data becomes wrong data.
- **A 200 carrying the wrong thing never overwrites a good cache.** The common
  upstream failure is not a 500; it is an HTML error page, a login redirect, or
  a truncated file — all of which parse.

---

## What this will never do

Not omissions. Decisions, and they are not negotiable:

- No credential harvesting, from browsers, other applications, or config files
  Meridian did not write.
- No scraping of leaked keys, paste sites, credential dumps, or "free key"
  databases.
- No account-creation automation, trial-credit farming, or disposable accounts.
- No rate-limit evasion, CAPTCHA solving, or authentication bypass.
- No credential rotation to work around a per-account limit. One upstream
  records this plainly — *"Account-level limits. Key rotation provides no
  benefit."* — and even where it would work, it is abuse of a provider's terms.

Discovery reads public documents and public listing endpoints. That is the
whole of it.

### And what discovery does not do to your gateway

Finding a provider registers nothing, enables nothing, spends nothing and calls
nothing. It puts a row in a list with a source and a date attached. Acting on it
is the operator's decision — which is the difference between a catalogue and a
gateway that signs itself up for things.

---

## Requests to addresses that are not public

Dataset URLs are configuration, and configuration is user input. Every fetch
goes through `assessUrl()` in `@meridian/shared`, so an operator cannot point
the discovery engine at `169.254.169.254` and read the cloud metadata service
back through the catalogue UI.

The same guard covers a provider's base URL, where the stakes are higher: every
call to a provider carries the operator's API key in an `Authorization` header,
so a base URL pointed at an internal host hands the credential to whatever logs
it. `PATCH /api/providers/:id` refuses private space unless the provider is
marked `local` — because Ollama and LM Studio genuinely live on `127.0.0.1`,
and a guard that broke the one free deployment is a guard people turn off.

The guard recognises the spellings that defeat a naive check:
`http://2130706433/`, `0177.0.0.1`, `::ffff:169.254.169.254`, 6to4, NAT64,
`metadata.google.internal`. See `tests/unit/net-guard.test.ts`, which is written
from the attacker's side.

---

## Licences

Everything redistributed is recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and served live at
`GET /api/discovery/attribution` — generated from the sources that actually
loaded, so it cannot drift from what is being redistributed.

The datasets are MIT and CC0. The provider endpoints are used as served and
their responses are cached, not republished.
