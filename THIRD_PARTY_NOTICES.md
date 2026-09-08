# Third-party notices

Meridian integrates data and architectural ideas from the projects below. This
file records what was used, under which licence, and — where it matters — what
was deliberately *not* used.

Meridian's own source remains under its own licence. Nothing here grants rights
over the upstream works beyond what their licences give.

---

## free-llm-api-hub — data, redistributed

- **Upstream:** https://github.com/pacocartones/free-llm-api-hub
- **Licence:** MIT — Copyright (c) 2026 Paco Cartones
- **What Meridian uses:** the canonical dataset `data/providers.json`, fetched
  at runtime and cached on disk.
- **How:** `packages/model-sdk/src/sources/free-llm-api-hub.ts` validates the
  payload against the upstream schema and normalises it into Meridian's
  provider registry. Meridian does **not** vendor a snapshot into the
  repository; the copy on disk is a runtime cache written by the operator's own
  instance.
- **Attribution surfaced in-product:** every synced provider carries a
  `provenance` block naming this source, its version and the date it was last
  verified, and `GET /api/catalog/status` returns the licence and attribution
  string.

MIT permits this redistribution. The upstream copyright notice is reproduced
below as the licence requires.

```
MIT License

Copyright (c) 2026 Paco Cartones

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### A note on what the data means

The dataset records what providers *say* about their own free tiers. Meridian
carries that through as a sourced claim with a date attached — never as its own
verification, and never with `null` upgraded to a definite answer. A provider
whose commercial-use permission upstream records as unconfirmed is shown as
`unknown` in Meridian, and is excluded from a "commercial use allowed" filter
rather than included in it.

---

## LiteLLM — data, redistributed

- **Upstream:** https://github.com/BerriAI/litellm
- **Licence:** MIT, **except** the repository's `enterprise/` directory, which
  its root `LICENSE` carves out under a separate licence of its own. Note that
  `litellm/proxy/enterprise` is a **symlink into that proprietary directory**,
  so a path that looks like it lives under the MIT tree may not — anyone
  extending this integration must check where a path really resolves before
  taking anything from it.
- **What Meridian uses:** exactly one file —
  `model_prices_and_context_window.json` — which sits at the repository root,
  squarely inside the MIT-licensed portion. It is fetched at runtime as a rate
  card and cached on disk (`packages/model-sdk/src/sources/litellm-pricing.ts`,
  `price-book-sync.ts`). No LiteLLM code, no proxy, and nothing from
  `enterprise/` (directly or through the symlink) is used or vendored.
- **Attribution surfaced in-product:** `GET /api/catalog/prices` returns the
  source, licence and attribution string, and every price the book fills in
  carries a note naming the source and how the match was made.

The upstream MIT notice applies to that file and is reproduced by reference:
Copyright (c) 2023 Berri AI, under the same MIT terms quoted in full above.

---

## awesome-free-llm-apis (mnfst and uzair004) — data, redistributed

- **Upstreams:** https://github.com/mnfst/awesome-free-llm-apis and
  https://github.com/uzair004/awesome-free-llm-apis (unrelated projects that
  share a name).
- **Licence:** both are **CC0 1.0 Universal** — a public-domain dedication, so
  redistribution and use need no further permission. Verified against each
  repository's licence file.
- **What Meridian uses:** their machine-readable registries of free-tier LLM
  APIs, fetched at runtime (`packages/model-sdk/src/sources/community-registries.ts`).
  mnfst contributes model listings and parsed rate-limit strings; uzair004
  contributes structured free-tier limits (`rpm`/`rpd`/`tpd`), access terms and
  rate-limit header names.
- **How the claims are treated:** as sourced community claims, never as
  Meridian's own verification. mnfst entries enter at `UNVERIFIED` confidence;
  uzair004 entries carry a `lastVerified` date and can reach `LIKELY`, decaying
  to `STALE` with age. Card/phone/commercial-use questions the data does not
  answer stay `unknown`.

---

## Architectural influences — concepts only, reimplemented

The projects below were read to understand how they solve problems Meridian
also has. No source code from any of them was copied. Where their behaviour
informed Meridian's, it was reimplemented against Meridian's own interfaces.

| Project | Licence | Concept taken |
| --- | --- | --- |
| [free-coding-models](https://github.com/vava-nessa/free-coding-models) | MIT | Continuously measuring provider health (latency distribution, jitter, uptime) instead of trusting static provider claims |
| [free-claude-code](https://github.com/itspsr/free-claude-code) | MIT | Provider rotation and falling back to another configured model rather than failing a whole task |
| [Codebuff / freebuff](https://github.com/CodebuffAI/codebuff) | Apache-2.0 | Specialised agents with per-task model selection. Its other idea — reviewing with a different model family than the one that implemented — was read and **not** built; see the gap recorded in [UPSTREAM_INTEGRATION_MATRIX.md](docs/UPSTREAM_INTEGRATION_MATRIX.md) |
| [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry) | MIT | Rate-limit handling: honouring `Retry-After`, bounded retry budgets, backoff with jitter |
| [cheapestinference/openclaw-plugin-ratelimit-retry](https://github.com/cheapestinference/openclaw-plugin-ratelimit-retry) | MIT | Same, as a pluggable retry policy |
| [cheapestinference/silos](https://github.com/cheapestinference/silos) | MIT | Usage monitoring around economical inference routing |

### Deliberate exclusion

`cheapestinference/examples` carries **no licence file**. Absent a licence, the
default is that no rights are granted, so nothing from that repository — code,
configuration or data — was copied or adapted. It is listed here only to record
that it was examined and excluded.

Apache-2.0 material (Codebuff, freebuff) was likewise not copied. Meridian's
agent-pool and task-routing code is its own; the influence is conceptual, which
is why no `NOTICE` propagation applies.
