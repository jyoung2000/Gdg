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
  APIs, fetched at runtime — schemas and normalisation in
  `community-registries.ts`, the sources themselves in `dataset-sources.ts`.
  mnfst contributes model listings and parsed rate-limit strings from
  `data.json`; uzair004 contributes structured free-tier limits
  (`rpm`/`rpd`/`tpd`), per-model capabilities, access terms and rate-limit
  header names from `registry.json` — one file for every provider, rather than
  a directory listing through the GitHub API and one call per provider against
  a rate limit shared with the whole host.
- **How the claims are treated:** as sourced community claims, never as
  Meridian's own verification. mnfst entries enter at `UNVERIFIED` confidence;
  uzair004 entries carry a `lastVerified` date and can reach `LIKELY`, decaying
  to `STALE` with age. Card/phone/commercial-use questions the data does not
  answer stay `unknown`.

---

## Redistributed inside the Windows desktop application

Everything below ships **as binaries or source, inside `Meridian-Setup-x64.exe`
and `Meridian-Portable-x64.zip`**. This is a stricter obligation than the data
sources above: these are executable works handed to end users, and their
licences travel with them.

The installer downloads nothing at runtime. What is listed here is what is in
the file.

### Node.js — redistributed binary

- **Upstream:** https://nodejs.org/dist
- **Version:** 22.23.2 (LTS "Jod", `NODE_MODULE_VERSION` 127), pinned by SHA-256
  in `apps/desktop/runtime.json` and verified on every download.
- **Licence:** MIT, plus the licences of the components Node itself embeds —
  V8 (BSD-3-Clause), libuv (MIT), OpenSSL (Apache-2.0), zlib, c-ares, llhttp and
  others. Node's own `LICENSE` file reproduces all of them in full.
- **What is shipped:** one file, `node.exe`, in `runtime/`. No npm, no headers,
  no toolchain.
- **How the licence travels:** `scripts/fetch-node-runtime.mjs` downloads
  `LICENSE` from the tagged release alongside the binary, and
  `scripts/package-desktop.mjs` places it in the payload as
  `runtime/LICENSE-node.txt`. It is installed next to the binary it covers, so
  the notice cannot be separated from the work.
- **Why it is bundled:** so that installing Meridian does not mean installing
  Node. A pinned runtime is also what makes the native addon's ABI a decision
  taken at build time rather than a property of whatever the user happened to
  have.

Meridian is not a modified distribution of Node and does not present itself as
one. The binary is the unmodified official build for the target platform.

### better-sqlite3 — redistributed, including a compiled binary

- **Upstream:** https://github.com/WiseLibs/better-sqlite3
- **Version:** 11.10.0 · **Licence:** MIT
- **What is shipped:** `package.json`, `LICENSE`, `lib/`, and the compiled addon
  `build/Release/better_sqlite3.node` — an allowlist, not a copy of the package.
  The full package is 12 MB of SQLite amalgamation and build intermediates, of
  which about 2 MB is needed to run.
- **SQLite itself**, which that addon statically links, is **public domain** and
  carries no attribution requirement. It is recorded here because "what database
  is in this thing" is a fair question to be able to answer.
- Its two runtime dependencies ship with it: **bindings** 1.5.0 (MIT) and
  **file-uri-to-path** 1.0.0 (MIT), each with its own licence file.

`prebuild-install` is deliberately absent. It is a dependency of
`better-sqlite3` and runs only during `npm install`; shipping it would put a
downloader into the installed application for no reason.

### Tauri — linked into the desktop shell

- **Upstream:** https://github.com/tauri-apps/tauri
- **Version:** 2.11.x · **Licence:** MIT **or** Apache-2.0, at the recipient's
  option. Meridian's use is under MIT.
- **What is shipped:** compiled into `Meridian.exe`, along with the plugins
  `tauri-plugin-single-instance` and `tauri-plugin-opener` (same dual licence)
  and the Rust crates in `apps/desktop/src-tauri/Cargo.lock`. That lockfile is
  the exhaustive list; `cargo tree` and `cargo about` will produce the full
  notice set from it.

### WebView2 — **not** redistributed

The window is rendered by Microsoft Edge WebView2, which is a **component of the
operating system**, already present on Windows 11 and on up-to-date Windows 10.
Meridian links against it and ships none of it. The NSIS installer will invoke
Microsoft's own bootstrapper if the runtime is missing; the portable archive
cannot, which is why its `README.txt` says so.

### The web client

Meridian's own React application, built by Vite into `server/web/`, is
Meridian's source under Meridian's licence. Its npm dependencies are compiled
into those bundles; `pnpm licenses list --prod` enumerates them, and every one
of them is MIT, ISC, BSD or Apache-2.0 — the check is part of the release
routine in [docs/RELEASE_WINDOWS.md](docs/RELEASE_WINDOWS.md).

---

## Provider listing endpoints — read, cached, not redistributed

Three sources ask a provider about its own models rather than reading a
third-party document: OpenRouter's `/api/v1/models`, Pollinations' model
endpoints, and Hugging Face's router listing. All three are public — no key, no
account — which is the reason they are here: someone who has configured nothing
should still be able to see what free inference exists.

These are **used as served**. The responses are cached on the operator's own
disk so a refresh is polite and an outage is survivable; nothing is republished,
vendored, or presented as Meridian's own data. Every model that comes from one
carries a `provenance` block naming the endpoint and the date it was read, and
`GET /api/discovery/attribution` returns the same list at runtime — generated
from the sources that actually loaded, so it cannot drift from what is being
used.

No terms of service are worked around to obtain any of it: these are documented
public endpoints, requested once per refresh interval, with conditional headers
so an unchanged response costs the provider nothing.

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
