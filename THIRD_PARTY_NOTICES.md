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

## Architectural influences — concepts only, reimplemented

The projects below were read to understand how they solve problems Meridian
also has. No source code from any of them was copied. Where their behaviour
informed Meridian's, it was reimplemented against Meridian's own interfaces.

| Project | Licence | Concept taken |
| --- | --- | --- |
| [free-coding-models](https://github.com/vava-nessa/free-coding-models) | MIT | Continuously measuring provider health (latency distribution, jitter, uptime) instead of trusting static provider claims |
| [free-claude-code](https://github.com/itspsr/free-claude-code) | MIT | Provider rotation and falling back to another configured model rather than failing a whole task |
| [Codebuff / freebuff](https://github.com/CodebuffAI/codebuff) | Apache-2.0 | Specialised agents with per-task model selection; reviewing with a different model family than the one that implemented |
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
