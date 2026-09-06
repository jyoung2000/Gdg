# API

Everything is served from one origin on port **4639**.

| Surface | Prefix |
| --- | --- |
| OpenAI-compatible | `/v1` |
| Anthropic-compatible | `/anthropic/v1` |
| Administration | `/api` |
| Live events | `/api/events` (SSE) and `/api/events/ws` (WebSocket) |
| Generated media | `/media/<file>` |

Authentication is off by default. With `MERIDIAN_AUTH_REQUIRED=true`, send
`Authorization: Bearer <key>` or `x-api-key: <key>`; create keys in Settings →
API keys, or `POST /api/system/keys`.

Errors are uniform:

```json
{ "error": { "code": "rate_limited", "message": "…", "provider": "groq", "model": "…" } }
```

`code` is from the taxonomy in `docs/ROUTING.md`. Every response carries
`x-request-id`.

---

## OpenAI-compatible

### `POST /v1/chat/completions`

Standard, plus two differences:

- **`model` is optional.** Omit it, or send `"auto"`, and Meridian chooses.
- **`meridian`** steers routing. A stock client that does not send it is
  unaffected.

```jsonc
{
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true,
  "meridian": {
    "mode": "FREE",           // AUTO | BEST | FAST | CHEAP | FREE | LOCAL | policy
    "pool": "coding",
    "provider": "groq",       // pin a provider
    "free_only": true,
    "local_only": false,
    "allow_paid": false,
    "budget": 0.05,           // hard USD ceiling
    "sensitive": true,        // never route to an unverified provider
    "task_type": "coding",    // improves model selection
    "workspace_id": "ws_…"
  }
}
```

Every response carries a `meridian` block with the provider, the model, the
attempt count, any fallbacks, the full routing explanation and total latency.
In a stream it arrives on the first chunk.

Also: `GET /v1/models`, `GET /v1/models/*`, `POST /v1/responses`,
`POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/audio/speech`
(returns raw audio), `POST /v1/audio/transcriptions` (base64 `file` field).

---

## Anthropic-compatible

```bash
export ANTHROPIC_BASE_URL=http://localhost:4639/anthropic
```

`POST /anthropic/v1/messages` with the full Messages contract: system as a
top-level field, typed content blocks, `tool_use` and `tool_result`, and
streaming as named events (`message_start`, `content_block_start`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).

Also `POST /anthropic/v1/messages/count_tokens` — which says
`meridian.estimated: true`, because the count is a heuristic until the serving
model reports the real one — and `GET /anthropic/v1/models`.

The point of this surface is that a Messages-API client routes through Meridian
to **any** model you have configured, not only Anthropic's.

---

## Administration

### System

| Route | Purpose |
| --- | --- |
| `GET /api/system/info` | Version, port, counts, sandbox posture, warnings |
| `GET /api/system/health` | Liveness — is the process alive |
| `GET /api/system/ready` | Readiness — can it serve a request. `503` with per-check detail when not |
| `GET /api/onboarding` | What a fresh install still needs, derived from live state |
| `GET /api/system/vocabulary` | Every enum the UI renders, with its copy |
| `GET/POST/DELETE /api/system/keys` | Gateway API keys. The plaintext is returned once |
| `GET /api/system/audit` | Audit log, secrets redacted |
| `GET/PUT /api/preferences` | The caller's preferences |

### Providers and credentials

| Route | Purpose |
| --- | --- |
| `GET /api/providers` | Catalog with support state, health, model counts |
| `PATCH /api/providers/:id` | Trust, base URL, data-use overrides |
| `POST /api/providers/:id/verify` | Live check; on success records verified capabilities |
| `POST /api/providers/:id/reset-health` | Clear the circuit breaker |
| `POST /api/providers/discover` | Re-read every listing, probe local servers |
| `GET/POST/PATCH/DELETE /api/credentials` | Credentials. **Secrets are never returned** — only a four-character hint |

### Models

| Route | Purpose |
| --- | --- |
| `GET /api/models` | Filter by search, modality, provider, free |
| `GET /api/models/detail?id=` | One model with scores, performance and benchmarks |
| `POST /api/models/benchmark` | Run the suite and fold the result into its scores |
| `POST /api/models/compare` | One prompt across up to six models |
| `POST /api/routing/preview` | Dry-run the router; executes nothing |

Model ids contain `:` and `/`, so they travel as a query parameter or a body
field rather than a path segment.

### Pools

`GET/POST/PATCH/DELETE /api/pools`, `POST/DELETE /api/reservations`.

### Workspaces, tasks, media, usage

| Route | Purpose |
| --- | --- |
| `GET/POST/PATCH/DELETE /api/workspaces` | Create, optionally cloning a repository |
| `GET /api/workspaces/:id/tree` · `/file` · `/search` | Read the workspace |
| `GET/POST /api/workspaces/:id/changes` | Review, accept or reject agent changes |
| `POST /api/workspaces/:id/exec` | Run a sandboxed command; reports its isolation |
| `POST /api/workspaces/:id/git` | status, diff, log, branch, stage, commit. **Never push** |
| `POST /api/tasks/estimate` | Calls, models, time, cost, and the chosen pipeline |
| `POST /api/tasks` | Start a task; returns immediately, progress on the event stream |
| `GET /api/tasks/:id` | Task, steps, tool calls, usage |
| `POST /api/tasks/:id/cancel` · `/feedback` | Stop it; teach the ranker |
| `POST /api/tasks/parallel` | Lanes in isolated workspace copies, with conflicts reported |
| `GET /api/tasks/:id/checkpoints` | Workspace snapshots taken before each step |
| `POST /api/tasks/:id/rewind` | Restore the workspace to a checkpoint. Refused while the task is running |
| `POST /api/tasks/:id/fork` | Copy the workspace (optionally rewound) and run a different request in it |
| `POST /api/generations/image` · `video` · `speech` · `transcribe` | Media jobs |
| `GET /api/usage?days=N` | Totals, by model, by provider, by day |

---

## Events

Both transports carry the identical event union, so there is one contract:

```jsonc
{ "type": "task",       "event": { "type": "step-update", "step": { … } } }
{ "type": "usage",      "record": { … } }
{ "type": "fallback",   "event": { "message": "Groq is rate limited right now. Switching to …" } }
{ "type": "generation", "job": { … } }
{ "type": "health",     "health": { … } }
```

Recent events are replayed on connect, so a client joining mid-task sees the
steps that already happened rather than a blank timeline.

---

## Idempotency

Send `Idempotency-Key: <your key>` on any `POST`, `PUT` or `PATCH` and the
response is stored against that key for 24 hours. A repeat of the same request
replays the stored response byte for byte instead of running it again, so a
client that retries after a timeout is not charged twice and does not start a
second agent task.

The key is scoped to the caller, the method and the path, so two callers cannot
collide and one route's key cannot replay another's.

| `X-Idempotency` | Meaning |
| --- | --- |
| `stored` | First time this key was seen; the response was recorded |
| `replayed` | The stored response was returned; nothing ran |
| `in-flight` | The original request is still running — `409`, wait rather than retrying |
| `conflict` | The key was used before with a different body — `422`, use a new key |
| `not-applied-to-streaming` | Streamed responses are bytes on a socket, not a value that can be replayed, so the key was ignored |

A request that fails with a `5xx` releases its key, so retrying it is allowed.
