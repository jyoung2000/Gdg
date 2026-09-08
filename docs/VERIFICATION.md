# Verification

How Meridian finds out what a model can do, and what it does when it cannot.

## Three things called "verified"

Worth separating first, because the same word meant three unrelated things and
one of them was misleading.

| Term | What it means | Set by |
| --- | --- | --- |
| `ProviderDescriptor.trust: 'verified'` | An operator's trust label, used by privacy modes | Hand-set, or hardcoded for local endpoints |
| `supportState: 'supported'` | This process has seen one call to this provider succeed | A successful listing or health check |
| `CapabilityClaim.state: 'probe_verified'` | Meridian sent a real request for this capability and the model did it | A probe — and, until this pass, nothing at all |

The third is the only one that is evidence about a *model*. A provider whose
descriptor says `trust: 'verified'` has had nothing verified; `discovery.ts`
assigns it to any local endpoint that answers a TCP connect.

## The evidence model

Every capability carries a claim: a state, where it came from, and when.

| State | Meaning | Rank |
| --- | --- | --- |
| `probe_verified` | A live call did it | 5 |
| `user_confirmed` | An operator asserted it | 4 |
| `unsupported` | Established as absent — a refused probe, or an operator who tested it | 4 |
| `provider_declared` | The provider's own listing says so | 3 |
| `inferred` | Guessed from the model's name. A guess, labelled | 2 |
| `unknown` | Nobody has said anything. **Never rendered as "no"** | 0 |

The ranking orders **how good the evidence is**, not what it concludes — and
getting that wrong had teeth. `unsupported` used to sit at the bottom, one below
`inferred`, so a guess from a model's name outranked a tested finding that the
capability was absent. An operator marking vision unsupported on a model called
`gpt-4o` had it overturned by the name heuristic on the next discovery pass:
the weakest evidence in the system beating the strongest, in the direction that
makes the router pick a model the request will fail on.

`unsupported` is only ever written deliberately, so it now ranks with
`user_confirmed` — above a provider's optimistic listing and far above a name
match, below a live call that actually succeeded, and level with an operator so
they can change their mind.

## Evidence survives a restart

It did not, until migration `008`. The `models` table had 14 columns and none of
them was `capability_claims`, so `upsertModels` wrote the flat capability array
and dropped the evidence. Combined with the ranking bug above, an operator's
finding lasted exactly as long as the process did.

Two changes make that structurally impossible now:

- `capability_claims`, `discovered_at` and `last_verified_at` round-trip through
  the database. First-sighting keeps its earliest value, so a rediscovery cannot
  reset how long a model has been known.
- **The flat capability list is a projection of the evidence**, not a second
  opinion beside it. It used to be an independent union of the provider listing
  and the name heuristic; it is now derived from the merged claims, so a
  capability must have a winning claim that is not `unsupported` to appear at
  all.

## Probes

`packages/provider-sdk/src/probe.ts`

A probe is a real request, which is the point and also the constraint. Each is
the smallest thing that can distinguish "does this" from "does not":

| Capability | Probe |
| --- | --- |
| `text` | A five-token completion |
| `tools` | One trivial tool, with `tool_choice: required` — a model that *can* call tools but chooses not to would otherwise look identical to one that cannot |
| `vision` | A 1×1 transparent PNG. What the model *says* is not graded: the question is whether the provider carries an image, not whether the model can see |
| `embedding` | One word, checking a vector comes back |

### The third outcome is the whole design

- **supported** — it did the thing. The only thing that writes `probe_verified`.
- **unsupported** — a *definitive refusal*: the provider rejected the request
  shape, saying this model does not take images, or tools, or whatever was asked.
- **inconclusive** — everything else. A timeout, a 429, a 500, an expired key.
  These say something about the day, not about the model, and **write no claim
  at all**.

Without that distinction, one bad minute on a provider would fill the registry
with false negatives that then outrank the provider's own listing. Verified
live: a run against a server that answers every completion with a 429 records
nothing and leaves the evidence byte-identical.

### What a probe run will not do

- Run on a timer. Every probe costs quota and, on a paid model, money.
- Run without a credential — that is a guaranteed auth error recorded as
  "learned nothing" for every model on the provider. It is skipped, with the
  reason given once.
- Probe an embedding-only model for tool calling.
- Hide its own cap. A run that touched 25 of 300 models says so, so it cannot
  read as "everything is verified".

## Where evidence changes behaviour

Routing reads it. The hard constraints check the flat capability list, so a
probe-verified claim and a name guess used to be indistinguishable to the thing
that actually picks the model. Evidence strength now scales the **reliability**
factor — semantically the right home, since reliability is "will this call
work" and a guessed capability is a coin flip that fails at the provider.

Deliberately a nudge, with a floor of 0.7 rather than a gate:

| State | Confidence |
| --- | --- |
| `probe_verified` | 1.0 |
| `user_confirmed` | 0.95 |
| `provider_declared` | 0.85 |
| `inferred` | 0.7 |

Refusing to route on a guess would leave every newly discovered model
unroutable until someone probed it, which is how a system ends up never using
anything new. Verification earns a better position rather than being the price
of entry. For a request needing several capabilities, the weakest link decides.

### Evidence ages

A claim older than 90 days — the same window the price and intelligence layers
use, so Meridian has one idea of "old" — is discounted rather than discarded.
Providers move models under stable ids: a context window doubles, vision
appears, a quantisation changes what the weights can do, and a verification is
evidence about the model as it was when it ran.

"We watched this work six months ago" is weaker than "we watched it work this
morning" and much stronger than "the name suggests it", so the decay floors at
`inferred`'s confidence. However old, something someone actually established is
never worth less than a guess — otherwise an aged verification would be worse
than never having run one.

## Using it

```
uag verify <provider:model>      # probe one model
uag verify <providerId>          # probe a provider's models, capped
uag verify <id> --limit 50       # raise the cap deliberately
pnpm verify:providers <target>
```

`POST /api/verification/run` is the same thing, admin-only. `uag models` shows
an EVIDENCE column, and the model inspector has a **Verify with a live call**
button.

## Known gaps

- **No re-verification schedule.** A stale claim is discounted, as above, but
  nothing schedules a re-probe. Deciding *when* to spend quota re-checking is a
  policy question with a real bill attached, and guessing at it would spend an
  operator's money on their behalf.
- **`setVerified` still stores compile-time introspection.**
  `adapter.capabilities()` derives from `typeof adapter.chat === 'function'` —
  which methods were written, not which ones work. It describes the adapter's
  surface and should be named that way.
- **No per-model health.** The circuit breaker is keyed by provider, so one
  broken model on a healthy provider cannot be taken out of rotation.
- **Probes cover four capabilities.** JSON mode, structured output, reasoning,
  audio and video have no probe. They stay at whatever evidence the listing or
  the name gave them.
