# Security

## Threat model

Meridian is self-hosted and holds **provider credentials** and **your source
code**. The three things that matter:

1. A credential must not leak — not through the API, a log, an error, an audit
   entry, or into a command a model wrote.
2. Model-authored code must not reach anything outside its workspace.
3. Private code must not be sent to a provider you have not accepted.

---

## Credentials

**At rest.** AES-256-GCM under a key derived with scrypt (N=2^15) from
`MERIDIAN_MASTER_KEY` and a per-instance salt. The salt lives in the database
and the master key does not, so the database file alone does not yield the key.
GCM is authenticated: a tampered ciphertext fails to open rather than
producing garbage that gets sent to a provider.

Without `MERIDIAN_MASTER_KEY` a key is generated into the database. That
protects a leaked backup but not read access to the live file, and the UI says
so on every start. **Set it in production.**

**In transit within the product.** A secret is decrypted only when a call is
about to be made, and only reaches the adapter's auth header.

**Never returned.** The API exposes a four-character hint. The
integration suite asserts that a secret sent to `POST /api/credentials` appears
in neither the create response, the list response, nor the audit log.

**Never logged.** The logger runs every field and message through the redactor
before any sink, which masks known credential shapes (`sk-`, `sk-ant-`,
`gsk_`, `AIza`, `ghp_`, `hf_`, `r8_`, `xai-`, `AKIA`, bearer tokens, JWTs) and
any field named like a secret.

**Never in the sandbox.** The sandbox builds its environment from scratch —
`PATH`, `HOME`, `LANG`, `TERM`, `CI` and nothing else. A denylist would leak
whatever it failed to anticipate.

**Discovery is bounded.** Automatic discovery reads the documented environment
variables and nothing else. It does not read browser storage, other
applications' configuration, shell history, cloud metadata services, or any
repository. Rotation is not evasion: credential pools spread load across
capacity you own and respect each key's own concurrency limit, and are
per-provider by construction.

---

## Sandboxing

**Docker mode** — the default in Compose, and the one to use:

```
--network none          no outbound network
--read-only             read-only root filesystem
--cap-drop ALL          no capabilities
--security-opt no-new-privileges
--memory / --memory-swap  hard memory limit; swap capped to match, or the
                          limit is escapable
--cpus, --pids-limit    CPU and process ceilings
--tmpfs /tmp            noexec, nosuid, vanishes with the container
-v <workspace>:/work    the only writable path
```

**Process mode** — the fallback where Docker is unavailable. A clean
environment, a wall-clock timeout, an output cap and process-group kill. It
limits accidents. It is **not a security boundary**: the command shares the
host filesystem and network and runs as the gateway's user. The UI states this
wherever a command can be started, and Meridian never silently degrades from
docker to process without recording a warning.

**Disabled mode** refuses every command.

---

## Path containment

Every workspace path resolves through one function, which refuses anything
outside the root — including a sibling directory sharing a prefix. Enforcing it
in one place is what keeps it enforced; a check at each call site is a check
that eventually gets missed. Covered by tests, including through the HTTP API.

---

## Web access

The agents' `web_fetch` tool exists only when `MERIDIAN_SANDBOX_NETWORK=true`.
When present it refuses non-HTTP schemes and loopback, link-local and
private-network addresses — a fetch tool that can reach `169.254.169.254` or
`localhost` is a cloud-metadata and internal-service exfiltration path, not a
research tool.

---

## Routing and privacy

| Mode | Effect |
| --- | --- |
| `STRICT_LOCAL` | Only local providers. Nothing leaves the machine |
| `TRUSTED_ONLY` | Only `verified` or `trusted` providers. The default |
| `FREE_PROVIDERS` | Adds providers whose data handling is unknown |
| `ANY_PROVIDER` | Every configured provider |

Independently of the mode, a request marked `sensitive` — which every workspace
under `STRICT_LOCAL` or `TRUSTED_ONLY` sets — is never routed to a provider that
is not verified or trusted.

Data-use policies ship as `unknown` for every remote provider, with a link to
the provider's own terms. Meridian does not guess what a third party does with
your code.

---

## Gateway hardening

- **CSP** with `default-src 'self'` and `object-src 'none'`. The one inline
  script (which applies the stored theme before first paint) is allowed by its
  **sha256 hash**, computed from the served file at startup — not by
  `unsafe-inline`.
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy` on every response.
- **Rate limiting** per credential or IP on the gateway APIs, with the bucket
  map swept so it cannot grow unbounded.
- **API keys** are stored as SHA-256 hashes; the plaintext is returned once and
  is not recoverable.
- **Passwords** use scrypt with a per-password salt and parameters recorded in
  the stored string, so they can be raised later without invalidating hashes.
- **Internal errors** return a stable sentence and the request id. Paths and
  stack detail stay in the log.
- **CORS** is same-origin unless origins are configured.

---

## Git

Agents may run `status`, `diff`, `log`, `branch`, `add`, `commit` and
`checkout`, built from a fixed command set rather than by passing a
model-authored string to a shell. **Push is not available to an agent**, and
neither is merging. Meridian never publishes anything on your behalf.

---

## Reporting

Open an issue describing the impact and how to reproduce it. Do not include a
working credential.

---

## Verifying the sandbox rather than trusting it

Every isolation guarantee is a flag on a `docker run` invocation. Flags are easy
to get wrong and impossible to check by reading, so Meridian probes the sandbox
at startup and the test suite exercises each one against a real container.

At startup, with `MERIDIAN_SANDBOX=docker`, the gateway checks that the daemon
answers, that the image exists, and — by running a probe container that reads a
file the gateway wrote and writes one back — that the mount really reaches the
same files in both directions. That probe exists because two misconfigurations
are otherwise silent and destructive:

- A containerised gateway passes its own path to `docker run -v`. The daemon
  resolves it against the *host*, creates an empty directory of that name, and
  every command runs against nothing while reporting success. Fixed by
  `MERIDIAN_WORKSPACE_HOST_ROOT`.
- A container user whose uid differs from the gateway's can read the workspace
  but never write to it, so anything that installs, builds or commits fails with
  a permission error that looks like a bug in the command. The sandbox therefore
  runs each container as the gateway's own uid and gid.

When any check fails, Meridian falls back to the process sandbox and says so —
in the startup warnings, in `GET /api/system/info`, and wherever the UI offers
to run a command. Silently downgrading the isolation an operator asked for would
be worse than not offering it.

`tests/e2e/docker-sandbox.test.ts` checks each guarantee by having a command
inside the container attempt the thing the flag forbids: writing outside the
workspace, reaching the network, reading the gateway's environment, outliving
its timeout, and forking without limit. It skips — with the reason printed —
when Docker or the sandbox image is absent, because a silently skipped security
test reads exactly like a passing one.
