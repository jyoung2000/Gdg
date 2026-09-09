# Changelog

Meridian's notable changes. Dates are release dates; the newest is first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-09-09

The first release. What follows is what is in it, and — as importantly — what is
in it but not yet verified against the real world.

### The gateway

- One port serves the web client, an OpenAI-compatible surface at `/v1`, an
  Anthropic-compatible surface at `/anthropic/v1`, and Meridian's own admin API.
- Routing across every configured provider with nine explicit policies behind
  six everyday modes. Every response carries the reasoning: what was chosen,
  what was considered, and what was ruled out by which rule.
- One fallback engine for rate limits, timeouts, 5xx, exhausted quota, rejected
  credentials and withdrawn models, with a shared retry budget, a circuit
  breaker per provider, and cooldowns that honour a provider's `Retry-After`.
- Health tracked at three levels that fail independently: provider, credential
  and model.

### Money

- Paid routing is off until an operator enables it *and* a request asks for it.
- `FREE` never selects a model that can charge. `FREE_FIRST` excludes paid
  candidates outright while free capacity remains — an ordering, not a scoring
  bonus.
- Free routing is quota-aware: a free route with room outranks a nearly-spent
  one, an unpublished allowance is neutral rather than assumed full, and a route
  with a published zero is removed by the credential layer with a stated reason.
- A trial credit is never labelled free. An unestablished cost is never labelled
  free, and ranks below a known price.

### Discovery

- Six discovery sources behind one plugin interface, merged under an explicit
  precedence with every claim keeping its origin, its confidence and its date.
- `GET /api/discovery/*` and a Free inference screen that shows which sources
  loaded, which failed and why, and what was excluded from the free list.

### Agents

- A coding request is decomposed across specialists, each routed to a model that
  suits its job and its economics. Every change is recorded with its previous
  content and can be reverted exactly until accepted.
- Commands run in a Docker sandbox where Docker exists, and in a process sandbox
  where it does not — which limits accidents and is **not** a security boundary,
  and says so.

### Interface

- Five primary destinations and one disclosure, down from twenty-two permanent
  ones. Nothing was removed: every screen is still reachable, and the UI suite
  clicks through the real navigation to all twenty-one to prove it.
- Chat is the landing screen. The right-hand inspector is contextual rather than
  permanently reserved.

### Platforms

- Docker Compose, a Windows desktop application with an NSIS installer and a
  portable archive, and a CLI.
- Two offline artefacts that open straight from disk with no server, no network
  and no install: `offline-ui/index.html` and
  `docs/mockup/meridian-gui-mockup.html`. Release verification refuses to ship
  either one stale.

### Security

- One address guard covering the agent fetch tool, the browser engine, the
  discovery engine and provider base URLs — the last of which previously
  accepted any URL, so a hosted provider could be repointed at a cloud metadata
  service and handed the operator's API key.
- Credentials encrypted at rest, masked in the UI, and stripped from logs before
  they are written.

### Not verified in this release

Stated here rather than in a footnote, because a release note that omits this is
the dishonest half of the announcement:

- **No live provider call has been made from the build environment.** Its egress
  policy refuses almost every provider API, so adapters are proved against a
  local simulator and captured response shapes, not against the providers.
  `MERIDIAN_LIVE_TESTS=1` with credentials configured completes this gate with
  no code changes.
- **The Windows installer has never been built.** The workflow that builds and
  installs it needs a Windows runner and has not yet run.
- **Docker is not exercised here.** There is no daemon in the build environment;
  the container gates report BLOCKED_EXTERNAL rather than passing.

See `docs/evidence/RELEASE.md` for what each run actually proved.

[1.0.0]: https://github.com/jyoung2000/Gdg/releases/tag/v1.0.0
