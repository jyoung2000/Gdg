# Configuration

Every setting is an environment variable. Meridian starts with none of them set
and reports what is missing rather than failing.

Defaults are in `packages/shared/src/config.ts`; the Compose file passes each
one through so `.env` is the single place to change them.

---

## Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `MERIDIAN_PORT` | `4639` | The one port serving the app, both APIs and the event stream |
| `MERIDIAN_HOST` | `0.0.0.0` | Bind address |
| `MERIDIAN_DATA_DIR` | `./data` | Root for the database and generated media |
| `MERIDIAN_DB` | `$DATA_DIR/meridian.db` | SQLite file |
| `MERIDIAN_WORKSPACE_ROOT` | `./workspaces` | Where agent workspaces are created |
| `MERIDIAN_ASSET_ROOT` | `$DATA_DIR/assets` | Generated images, video and audio |
| `MERIDIAN_WEB_ROOT` | auto-detected | Built web client. Found automatically at `dist/web` or `apps/web/dist` |
| `MERIDIAN_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `MERIDIAN_LOG_FORMAT` | `json` | `json` for ingestion, `pretty` for a terminal |

## Security

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERIDIAN_MASTER_KEY` | *(generated)* | Encrypts stored credentials. **Set this in production.** Without it a key is generated into the database, which protects a leaked backup but not read access to the live file. Generate with `openssl rand -base64 32` |
| `MERIDIAN_AUTH_REQUIRED` | `false` | Require an API key on `/v1`, `/anthropic` and `/api` |
| `MERIDIAN_ADMIN_EMAIL` | `operator@localhost` | Bootstrap operator, created only when no users exist |
| `MERIDIAN_ADMIN_PASSWORD` | *(none)* | Password for that account |
| `MERIDIAN_RATE_LIMIT` | `240` | Requests per minute per credential or IP, on the gateway APIs |
| `MERIDIAN_CORS_ORIGINS` | *(none)* | Comma-separated origins. Unset means same-origin only |
| `MERIDIAN_TRUST_PROXY` | `false` | Trust `X-Forwarded-*`. Enable only behind a proxy you control |

## Economics

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERIDIAN_ALLOW_PAID` | `false` | Master switch. While false, **no** request can reach a model that can charge, whatever it asks for |
| `MERIDIAN_ROUTING_MODE` | `AUTO` | Default routing mode |
| `MERIDIAN_PRIVACY_MODE` | `TRUSTED_ONLY` | `STRICT_LOCAL` · `TRUSTED_ONLY` · `FREE_PROVIDERS` · `ANY_PROVIDER` |
| `MERIDIAN_MAX_TASKS` | `4` | Concurrent agent tasks |

Paid routing needs **both** the instance switch and per-request permission
(`meridian.allow_paid`, `--paid`, or the user's saved preference). Either alone
is not enough.

## Sandbox

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERIDIAN_SANDBOX` | `process` (`docker` in Compose) | `docker` · `process` · `disabled` |
| `MERIDIAN_SANDBOX_IMAGE` | `meridian-sandbox:latest` | Image for docker mode |
| `MERIDIAN_SANDBOX_MEMORY_MB` | `2048` | Hard memory limit; swap is capped to match |
| `MERIDIAN_SANDBOX_CPUS` | `2` | CPU limit |
| `MERIDIAN_SANDBOX_TIMEOUT_MS` | `120000` | Wall-clock ceiling per command |
| `MERIDIAN_SANDBOX_NETWORK` | `false` | Outbound network from sandboxed commands. **Also gates the agents' `web_fetch` tool** |

If `docker` is requested and unreachable, Meridian falls back to `process` and
records a warning that is shown in the UI. It does not pretend to isolation it
does not have.

## Discovery

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERIDIAN_DISCOVERY_INTERVAL_MS` | `900000` | Re-read provider model listings. `0` disables |
| `MERIDIAN_HEALTH_INTERVAL_MS` | `120000` | Provider liveness probes. `0` disables |
| `MERIDIAN_LOCAL_ENDPOINTS` | localhost 11434, 8000, 8080, 1234 | Comma-separated base URLs probed for local inference servers |

In a container, reach a host-side Ollama with
`http://host.docker.internal:11434`.

## Provider credentials

Each is optional. The first documented variable for a provider wins; the rest
are aliases.

| Provider | Variable |
| --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| SambaNova | `SAMBANOVA_API_KEY` |
| Together | `TOGETHER_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Hyperbolic | `HYPERBOLIC_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google AI Studio | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| xAI | `XAI_API_KEY` |
| Hugging Face | `HF_TOKEN`, `HUGGINGFACE_API_KEY` |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` **and** `CLOUDFLARE_ACCOUNT_ID` |
| fal.ai | `FAL_KEY` |
| Replicate | `REPLICATE_API_TOKEN` |
| AI Horde | `AI_HORDE_API_KEY` |
| Ollama | `OLLAMA_HOST` (base URL, not a key) |

Environment credentials are re-read on every start, so rotating a key is a
restart rather than a database edit.

**This is the whole of automatic discovery.** Meridian does not read browser
storage, other applications' configuration files, cloud metadata services, or
any repository.
