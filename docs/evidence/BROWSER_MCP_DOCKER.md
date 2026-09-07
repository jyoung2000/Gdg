# Browser, MCP, Docker & Version Control — capability status

Honest status of the autonomous-browser, MCP control-plane, Docker QA and
version-control work. Each row says what was actually exercised, in this
environment, and what remains unverified. The vocabulary is the project's:
VERIFIED (run and observed here), IMPLEMENTED_UNVERIFIED (built and typechecked,
not exercised end to end here), BLOCKED_EXTERNAL (a real dependency this
environment cannot provide).

## Browser engine

| Capability | Status | Evidence |
| --- | --- | --- |
| Chromium engine (launch, navigate, snapshot, click, fill, screenshot, tabs) | **VERIFIED** | `tests/e2e/control-plane.test.ts` and live smokes: a real page navigated, interactive elements tagged with refs and clicked, a 122 KB screenshot captured, the counter of a Dockerized app clicked from 0→1. |
| Domain policy (private/loopback/metadata refusal, deny-over-allow, whitelist) | **VERIFIED** | `tests/unit/control-plane.test.ts` + e2e: `http://169.254.169.254/` and `localhost` refused with a typed error unless explicitly allow-listed. |
| Session control (per-op timeout, cancel, idle reap, observable log) | **VERIFIED** | Manager smokes: an operation bounded to 1 ms cancels with `code=cancelled`; the session log records every action; idle timer closes the session. |
| Profile persistence (cookies/origins sealed) | **VERIFIED** | Smoke: profile saved and listed with cookie/origin counts only; gateway seals the state with its `SecretBox`. |
| Lightpanda "fast" engine | **IMPLEMENTED_UNVERIFIED** | Implemented as a CDP attach (`chromium.connectOverCDP`) with automatic fallback to Chromium on a failed navigation, logged. No Lightpanda binary/endpoint was available here, so the attach path itself was not exercised. The fallback logic is unit-covered via the manager's engine-order handling. |
| Real-browser engine (`cdp`, browser-harness style) | **IMPLEMENTED_UNVERIFIED** | Attaches to a user's Chrome over `MERIDIAN_BROWSER_CDP_URL`; never falls back silently (a real-browser request is always a hard request). No external CDP endpoint here to attach to. |
| Stagehand-style act/observe/extract | **NOT BUILT as Stagehand** | The equivalent surface exists behind the provider interface — snapshot returns an accessibility/element model, `browser_act` acts by ref, `web_extract` does schema extraction — without requiring Browserbase hosted infrastructure. It is not the Stagehand library. |

## Web research / scrape / extract

| Capability | Status | Evidence |
| --- | --- | --- |
| Scrape (render, readable text, links) with TTL cache | **VERIFIED** | Research smoke: live page scraped, second identical request served from cache. |
| Extraction escalation DOM → accessibility → LLM | **VERIFIED (DOM/a11y); IMPLEMENTED_UNVERIFIED (LLM leg)** | DOM extraction returned the page title at 0.9 confidence; a field with no deterministic answer came back honestly scored <0.5 with an error rather than a guess. The LLM leg is wired through the router FREE_FIRST; it needs a configured model to exercise (none here). |
| robots.txt awareness | **VERIFIED** | A disallowed path is refused with a clear message and still recorded as a failed provenance record — never bypassed. |
| Per-domain politeness spacing | **VERIFIED** | Two same-domain fetches spaced ~1 s apart in the smoke. |
| Provenance records (including failures) | **VERIFIED** | Every extract, success or refusal, produces a record persisted to `research_records`. |
| CAPTCHA / auth / paywall bypass | **NOT BUILT, by design** | There is no primitive for it. A page that refuses to be read comes back as a failed record. |

## MCP control plane

| Capability | Status | Evidence |
| --- | --- | --- |
| stdio transport | **VERIFIED** | e2e + smoke: `@modelcontextprotocol/server-everything` spawned via npx, `initialize`/`tools/list`/`echo` round-trip, protocol 2025-06-18. |
| Streamable HTTP transport | **VERIFIED** | Same server in `streamableHttp` mode on 3001: initialize, tools/list, echo over HTTP incl. SSE-response parsing and `mcp-session-id`. |
| Official registry (live search) | **VERIFIED** | 13 installable servers returned for "browser"; catalog degrades honestly (curated survives) when the registry is unreachable. |
| Curated catalog incl. browser-harness & GitHub | **VERIFIED** | browser-harness carries its documented `uvx --from 'browser-harness[mcp]' browser-harness-mcp`; GitHub carries the hosted `api.githubcopilot.com/mcp/` endpoint and the ghcr docker form. |
| Guarded install (plan shows exact command, nothing runs unseen) | **VERIFIED** | `/api/mcp/install/plan` returns the verbatim command; `confirm` stores it. UI shows it in a dialog before Add. |
| Sealed secrets (write-only; explicit reveal only) | **VERIFIED** | Unit + smoke: a stored secret never appears in list/get; `reveal` is the one audited read. |
| Health dashboard | **VERIFIED** | Live health reports running/failed/unhealthy with latency; an unstartable server reports `failed` with its error. |
| Model→tool policies (global/workspace/session, deny>allow) | **VERIFIED** | Unit + smoke: session-scope allow overrides a global deny; without the session, the deny still applies. |
| Playground | **VERIFIED** | `/api/mcp/servers/:id/call` and the UI playground call a tool and show the raw response (echo round-trip). |
| Presets/bundles | **IMPLEMENTED_UNVERIFIED** | CRUD + apply implemented and typechecked; not exercised end to end here. |
| Meridian AS an MCP server (`/mcp`) | **VERIFIED** | `initialize` and `tools/list` over HTTP returned `meridian_chat`/`meridian_models`/`meridian_scrape`/`meridian_extract`; authenticated like `/v1`. |

## Docker development orchestration

| Capability | Status | Evidence |
| --- | --- | --- |
| Detect docker/compose + project shape | **VERIFIED** | Live: Docker 29.3.1 + compose detected; both a Dockerfile fixture and the repo compose project detected with services. |
| build / up / waitHealthy / down with session isolation | **VERIFIED** | The fixture built and ran under `meridian-test-<project>-<session>`; teardown left zero session-labelled containers. |
| docker+browser verify loop | **VERIFIED** | The full loop built the fixture, waited for its healthcheck, drove real Chromium to click its button and observe the server-side counter change, then tore down. |
| Failure classification + retry budget | **VERIFIED** | A deliberately broken build classified `BUILD_FAILURE` and failed fast without spending a retry; NETWORK/HEALTH/DAEMON classification unit-covered. "Flake" is never a root cause — retries are spent only on retryable classes. |
| exec / logs (admin-gated, workspace-contained, audited) | **VERIFIED (routes)** | Path containment refuses a path outside the caller's workspaces; exec is admin-only and audited. |

## Version control

| Capability | Status | Evidence |
| --- | --- | --- |
| status / branches / create / switch / commit / log / diff | **VERIFIED** | Live against a real workspace repo: branch created + switched, a commit made on it, log and branch list reflect it. |
| fetch / pull / push | **VERIFIED (push error path)** | Push with no remote returns git's own "No configured push destination" verbatim — Meridian invents no success. Credentials are whatever the host already has; Meridian stores none. |
| gh CLI detection + PR create/list | **VERIFIED (detection); IMPLEMENTED_UNVERIFIED (PR)** | `gh` correctly reported not-installed on this host. PR create/list are gated on gh being installed and authenticated, and the UI says so. |
| GitHub MCP server | **VERIFIED (catalogued)** | Present in the curated catalog with its hosted-HTTP and ghcr-docker install plans and its PAT env hint. |

## UI

| Capability | Status | Evidence |
| --- | --- | --- |
| Browser, MCP, DevOps, Version Control screens | **VERIFIED** | The built bundle was driven by Meridian's own browser engine: all four nav items present, the MCP and Version Control screens rendered on navigation. |
| Header usage / limits / provider meter | **VERIFIED** | Renders today's cost (`$0.00`/Ready here), and is wired to show request/token counts (live from usage events), the last model + provider with the provider's health, and the primary pool's daily budget as the enforced spend limit. |

## External blockers (never circumvented)

- Docker Hub blob CDN, deb.debian.org, ghcr blobs, api.github.com, and the
  Lightpanda binary host are blocked by this environment's egress policy. The
  Docker gates ran against a legitimate alternate registry
  (`mcr.microsoft.com`) via `BASE_IMAGE`; none of these were bypassed.
- No Lightpanda endpoint and no external Chrome CDP endpoint were available, so
  those two engines are IMPLEMENTED_UNVERIFIED here.
- `gh` is not installed on this host, so PR creation is unexercised.
