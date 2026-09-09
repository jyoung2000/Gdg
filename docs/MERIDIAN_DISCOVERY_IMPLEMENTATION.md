# The free-inference discovery engine — what was built and what was proved

Written to be checkable. Every claim names the thing that produces it, and the
things that were not verified are listed as plainly as the things that were.

---

## What was there before

An audit of the existing code found the discovery layer was a specification
without an implementation:

- **`DiscoverySource` had zero implementations.** Grepping the whole repository
  for the name found it only in the file that defines it. The interface, the
  `SourceSnapshot` shape, the `DiscoveryContext` — all declared, none used.
- **`SOURCE_PRECEDENCE`, `ageAdjusted`, `CONFIDENCE_LEVELS` and `contributes`
  were referenced only by `types.ts` and by unit tests of those pure
  functions.** Nothing consulted the precedence table, because nothing merged.
- **The community registries were schemas and normalisers with no fetcher and
  no call site.** `parseRateLimitText`, `freeQuotaOf`, `uzairIntelligence` were
  correct, tested, and unreachable.
- **`Pricing.freeQuota` was populated by nothing**, so a quota-aware policy had
  nothing to bind to.
- **Dataset sources had no scheduler.** They ran at boot from cache and on a
  manual POST, and never otherwise.

That is a coherent design that was never wired up — which is a worse state than
an absent one, because it reads as finished.

---

## What was built

| | |
| --- | --- |
| `sources/http.ts` | One cached, conditional, SSRF-guarded fetcher for every source |
| `sources/dataset-sources.ts` | free-llm-api-hub, uzair004, mnfst as real `DiscoverySource`s |
| `sources/native-sources.ts` | OpenRouter, Pollinations, Hugging Face |
| `sources/registry.ts` | The merge: precedence, confidence, per-field standing, origins |
| `sources/free-ranking.ts` | Verdicts and ranking, with a stated reason per position |
| `services/free-inference.ts` | The gateway service: boot from cache, scheduled refresh |
| `routes/discovery.ts` | Six endpoints |
| `DiscoverScreen` → Free inference | The screen, with the evidence one click away |
| `shared/net.ts` | One address guard, replacing four partial copies |

---

## What was proved, and how

### Against the live upstreams, in this environment

`tests/e2e/discovery-live.test.ts` — 8 tests, run against the real internet:

| | |
| --- | --- |
| free-llm-api-hub loads | 69 providers, 31 routable, 84 models, version 2.9.0 |
| uzair004 loads, and populates `freeQuota` | 7 providers, 31 models, real `rpm`/`tpd` numbers |
| mnfst loads, and **nothing is called free on the strength of the repository's name** | 16 providers, 112 models, every one `UNKNOWN` |
| A second pass costs upstream nothing | ETags stored, 304 returned, `fromCache` true |
| An unreachable source reports itself and leaves the others working | the three provider-native endpoints are genuinely blocked here |
| The merge honours precedence, and every overruled claim had less standing | asserted per field, per model |
| Every surviving claim cites a source that actually loaded | |
| Every source records its licence and attribution | |

### Merged output, on that live data

```
77 providers · 202 models · 126 free
excluded from "free": 43 costs money (credit), 33 cost is not established
refusals: 16 access-terms claims from mnfst, which never declared it observes them
```

The precedence table earns its place. On `google-gemini:gemini-2.5-flash`,
free-llm-api-hub (verified-dataset, standing 303) wins the rate card over mnfst
(community-catalog, 201), while mnfst still supplies the context length the hub
does not publish. Both facts are recorded with the source that supplied them.

### In tests, without the network

- `tests/unit/discovery-merge.test.ts` — 18 tests: precedence, confidence
  tie-breaks, stability on a tie, per-field refusals, unknown-never-becomes-free,
  cache behaviour (304, failure, an error document that parses, an SSRF URL,
  offline), and the OpenRouter rate-card reader.
- `tests/unit/discovery-native.test.ts` — 11 tests against captured response
  shapes, including a per-token → per-million conversion that would be wrong by
  10⁶ in silence, and an unreadable rate that must stay `UNKNOWN` rather than
  becoming zero.
- `tests/unit/net-guard.test.ts` — 19 tests written from the attacker's side.
- `tests/e2e/discovery-routes.test.ts` — 8 tests through the real gateway,
  including a second boot on the same data directory and an assertion that boot
  makes **zero** outbound requests.
- `tests/router/free-quota.test.ts` — 5 tests driven from real response headers.

### In a browser

The Free inference tab was opened against a running gateway and photographed.
No console errors. It reported "3/6 loaded" and named the three that failed with
their HTTP status, and "126 of 126 shown. Excluded: 43 because costs money;
33 because cost is not established."

---

## What is not proved

- **The three provider-native sources have never talked to their live
  endpoints.** This environment's egress policy refuses `openrouter.ai`,
  `huggingface.co` and `pollinations.ai` at CONNECT — all three return 403 from
  the proxy, which is exactly what the status endpoint reports. What is proved
  is the parsing, against the documented response shapes, and that a failure is
  reported rather than thrown. What is **not** proved is that the live responses
  match those shapes. One `curl` settles it on any machine with network access;
  see [DISCOVERY.md](DISCOVERY.md).
- **No live inference call has been made to any discovered provider.** Discovery
  reads listings; it does not verify that a model serves. A `probe_verified`
  capability claim still requires the verification service and a credential.
- **The ranking weights are a considered judgement, not a measured optimum.**
  They are stated in code and in the docs so they can be argued with, and every
  ranked row shows its own arithmetic.

---

## Defects found and fixed on the way

**The web bundle had not built since the platform work landed, and it was
pushed.** `platform.ts` statically imports `node:os` and `node:path`, it is
exported from the shared barrel, and the web client imports that barrel — so
vite failed at link time, before tree-shaking could drop anything. The path
grammar is now written out, with a test asserting it agrees with `node:path`
over 27 cases. That test immediately earned its keep: Node decides UNC from the
first argument rather than the joined string, so `join('/', 'a')` was producing
`\\a` — a share name where a root was meant.

**The gateway started once and then never again.** The discovery service closed
over the credential resolver and was constructed four lines before it. With an
empty cache nothing is ranked and nothing notices; with a cache from the first
run the closure fires during boot and the process dies in the temporal dead zone
before it can log why. Fixed by construction order, and pinned by a test that
boots twice.

**`PATCH /api/providers/:id` accepted any `baseUrl` with no validation.** Every
call to a provider carries the operator's API key in an `Authorization` header,
so repointing a hosted provider at `169.254.169.254` sends that key to the cloud
metadata service on the next request. Now guarded, with loopback still allowed
for a provider that genuinely runs there.

**The address guard existed in four partial copies** — agent fetch, browser
engine, discovery, and none at all on the route above. They had drifted: none
recognised `http://2130706433/` as loopback. One guard now, in
`@meridian/shared`.

**A `contributes` declaration was wrong**, and the effect was silent: 30
capability claims uzair004 was entitled to make were being refused, and the
models came out looking less capable than the data said.

**The uzair source was pointed at `api.github.com/.../contents/providers`** — a
directory listing, one unauthenticated API call per provider against a
60-per-hour budget shared with the whole host. The repository publishes
`registry.json`: every provider, one request.

**`Pricing` was being built through an `as Pricing` cast** that hid missing
required fields, and would have written a quota-only row with no `kind`. Replaced
with a constructor that sets `kind: 'UNKNOWN'` and null rates — because writing
`0` there would turn "we do not know" into "it is free", which is the single
failure this subsystem exists to prevent.

---

## The prohibitions, and where they are enforced

Not omissions — decisions, each with a place in the code:

| | |
| --- | --- |
| No credential harvesting | Nothing reads a browser profile, another application's config, or any file Meridian did not write |
| No scraping leaked keys or credential dumps | The source list is six named public documents and endpoints |
| No account-creation or trial-credit farming | Discovery makes no account and calls no provider |
| No rate-limit or CAPTCHA evasion | Requests are conditional and paced at hours; a 429 backs off |
| No credential rotation to beat a per-account limit | Pools rotate across capacity the operator owns, per provider, and one upstream records plainly that rotation gains nothing |
| No SSRF | `assessUrl` on every dataset fetch and every provider base URL |
| Never label unknown as free | `UNKNOWN` scores 0, below paid, and is excluded from every free filter |
| Never turn README text into fact | mnfst's entire catalogue comes out `UNKNOWN`, and the live test asserts it |

---

## Honest summary

The plugin layer is real, three of six sources are verified against their live
upstreams, the merge and the ranking do what they say and show their working,
and the result reaches both an API and a screen. The three provider-native
sources are implemented and unit-proved but have never met their endpoints from
this machine, and that is stated everywhere it matters rather than rounded up.
