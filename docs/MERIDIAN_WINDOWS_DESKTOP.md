# Meridian as a Windows application

What was built, what was proved, where it was proved, and what is still
unproved. Written to be checkable: every claim below names the thing that
produces it.

---

## What was asked for

A Windows desktop application, installable from a single `.exe`, with no Node,
no pnpm, no Docker, no terminal and no GitHub account required of the person
installing it. Explicitly **not** a wrapper that opens `localhost` in a browser,
and explicitly not at the cost of the Docker deployment, the CLI, or the
gateway's own design.

## What it is

```
Meridian.exe   Rust · Tauri 2 · 1,761 lines · WebView2 window · tray icon
   │
   ├─ picks a port, 4639 first, then a free one
   ├─ mints or unwraps the credential master key   BCryptGenRandom + DPAPI
   ├─ spawns  runtime\node.exe server\gateway\main.js
   ├─ waits for  meridian-ready <port>  on stdout
   ├─ navigates the window to  http://127.0.0.1:<port>
   ├─ publishes  %LOCALAPPDATA%\Meridian\runtime\instance.json
   └─ on exit: SIGTERM-equivalent, then kill; never leaves an orphan
```

The window loads a **local page first** and only then navigates to the gateway.
That is the difference between a failed start showing a diagnostic screen with
the gateway's last words on it, and showing a blank window or a browser's
connection error.

The product is served by the gateway over loopback rather than bundled into the
webview. The alternative — bundling `dist/web` into the shell — would make the
application a cross-origin client of its own gateway, requiring CORS to be
widened and the gateway's CSP loosened **for every deployment, Docker included**,
to suit the desktop build. Paying a real security cost in the server to move
local files from one local place to another was not worth it.

The shell is not a browser and does not embed one it controls: WebView2 is an
operating-system component, and nothing about the gateway's API surface is
reachable from it that is not reachable from `curl` on the same machine.

---

## What was proved, and where

Verification is split by what a machine can actually answer. This environment is
Linux; a Linux machine cannot prove a Windows installation, and saying otherwise
would be the exact failure mode this report exists to avoid.

### Proved here, on Linux, in this session

| | Evidence |
| --- | --- |
| The payload boots on its own bundled runtime | `scripts/verify-desktop-payload.mjs` — outside the checkout, `PATH` untouched: health 200, database created by the bundled addon, web client served, clean stop over stdin |
| The shell spawns, owns and stops the gateway | The Linux build under Xvfb: gateway spawned, migrations applied, port 4639 bound, `instance.json` written |
| No orphan on an abnormal exit | `SIGKILL` of the shell → the gateway exits within 3 s and releases the port |
| Windows path decisions | `tests/unit/platform-paths.test.ts` — 17 tests, `win32.join`, `%APPDATA%` / `%LOCALAPPDATA%` splits |
| Windows shell selection | `tests/unit/windows-runtime.test.ts` — 4 tests |
| Desktop lifecycle | `tests/e2e/desktop-lifecycle.test.ts` — 7 tests: port fallback, ready line, state file, stdin shutdown |
| The shell's own logic | `cargo test` — 19 tests: ports, paths, secret handling, log redaction |
| The portable archive | `tests/unit/portable-archive.test.ts` — 5 tests, read back with the system `unzip`, then booted by the payload verifier |
| Cross-platform packaging refuses to ship the wrong binary | `package-desktop.mjs` reads the addon's magic bytes: `elf, expected pe` → fail and delete |
| The signing hook's decision paths | Run directly: no certificate → unsigned + warning, exit 0; `MERIDIAN_REQUIRE_SIGNING=1` → exit 1; wrong platform → exit 1 |

### Proved only on a Windows runner

`.github/workflows/windows-desktop.yml` — every row is a step that fails the
build, not a note in a report:

| | |
| --- | --- |
| `better-sqlite3` **loads** under the pinned Node | not "the file exists" — it is `require`d |
| The platform test suites, on Windows | where the answers are real |
| `cargo test --release` | |
| The payload boots on Windows | database created, web client served, stops on request |
| The installer installs silently, unelevated | `/S`, `currentUser` |
| The installation carries runtime, gateway, client and migrations | and the installed `node.exe` reports the pinned version |
| Launching it starts a gateway that answers | health 200, `/` serves the client |
| `master.key` exists in `%APPDATA%`, DPAPI-wrapped | |
| Killing the shell kills the gateway | |
| Reinstalling leaves the database **byte-identical** | hashed before and after |
| Uninstalling removes the program and **keeps** the data | both halves fail the build |
| The portable archive unpacks and boots | |

### Not proved by anyone yet

- **Nothing on this list has run on a Windows runner in this session.** The
  workflow is written and its YAML parses; it has not been executed. The first
  run of `workflow_dispatch` is the first real evidence, and until then the
  Windows column above is a *specification of what will be checked*, not a
  result.
- **The installer has never been built.** `tauri build` needs Windows.
- **Authenticode signing has never been executed against a real certificate**,
  because there is no certificate. The script's decision paths were exercised;
  the `signtool` invocation was not.
- **WebView2 absence** — the behaviour when the runtime is missing is handled in
  code and documented for the portable build. It has not been observed, because
  every Windows runner has WebView2.
- **Windows on ARM.** `runtime.json` pins no `win32-arm64` artefact, and the
  packaging script fails cleanly rather than guessing.

---

## The Unix assumptions that were found

Each was a genuine defect that would have shipped as "it installs and then
nothing works", and each is now pinned by a test.

**`spawn('/bin/sh', ['-lc', cmd])`** ran every agent command. On Windows that is
`ENOENT`, surfaced as "Failed to start command" — with the gateway itself
running perfectly, so nothing at startup explained it. Every build, every test
run, every `git commit`, every clone into a new workspace failed that way.
`shellFor()` now picks Git for Windows' `bash.exe` when present (Meridian
composes POSIX command lines, so `cmd.exe` would trade one failure for a subtler
one) and falls back to `cmd.exe`.

**`findWebRoot()`** resolved relative to the current working directory. A Start
menu shortcut launches with a cwd of anywhere.

**Migrations were read from `database/migrations` at boot** and were not in the
payload at all — found by the payload verifier, not by review. A payload without
them starts and then fails on an empty database.

**Paths were POSIX-joined.** Six of the first seventeen path tests failed on the
Linux machine writing them, because `path.join` emits `/`. `platformPaths()`
takes the platform as an argument and uses `win32.join`, which is what makes a
Windows path bug catchable on a Linux machine.

**`secret_at` sliced a `&str` on a byte index** — `rest[..7]` — and panicked on
any multi-byte character. The log writer redacts secrets, so this would have
crashed on the first log line on any machine whose user name is not ASCII.
Caught by a Rust test written to be awkward; fixed with `rest.get(..n)`.

---

## Security decisions

**The master key is not in the database.** The shell mints 32 bytes with
`BCryptGenRandom`, wraps them with DPAPI (`CryptProtectData`,
`CRYPTPROTECT_UI_FORBIDDEN` so a broken key never blocks on a UI prompt), and
writes `master.key` beside the database. A copied `meridian.db` is useless on
another machine or under another Windows account.

**The key reaches the gateway through the environment, never argv.** Command
lines on Windows are readable by any process on the machine through WMI.

**The same rule governs the signing hook.** The PFX password is imported through
PowerShell reading it from the environment, never passed to `signtool /p`; the
temporary PFX is owner-only with an explicit ACL and deleted in a `finally`, and
the imported certificate is removed from the store.

**Logs are redacted before they are written**, not before they are shown —
because the failure mode is a user pasting `meridian.log` into an issue.

**The installer downloads nothing.** Node 22.23.2 is pinned by SHA-256 in
`apps/desktop/runtime.json` and verified on every fetch, so a swapped artefact
fails the build rather than shipping.

**Nothing is harvested.** No credential is read from a browser, another
application, or any config file Meridian did not write.

**The process sandbox is described as what it is.** Without Docker, agent
commands run in a process sandbox that limits accidents and is **not a security
boundary**. The home screen says which one is in use and never claims isolation
it does not have.

---

## Deliberate design decisions

**Closing the window does not quit.** `uag`, an editor pointed at the
OpenAI-compatible API, and anything else the user configured are all talking to
this gateway. Killing the server because a window closed would break all of them
silently. The window hides, the tray stays, quitting is deliberate — and the
user is told this once, not every time.

**Launch gates on liveness, not readiness.** A fresh install has no models, so
readiness is 503 and correctly so. Gating the window on readiness would make a
first-time user wait forever for a state that only arrives after they add a
provider.

**Uninstalling keeps `%APPDATA%\Meridian`.** Deleting someone's database and
workspaces as a side effect of removing a program is not a decision software
should take on its own. The uninstall test fails if it does.

**Data and program are in different directories** — precisely so that the
sentence above can be enforced.

---

## What did not change

- The Docker deployment. `docker/Dockerfile` and `docker-compose.yml` are
  untouched, and CI still builds the image and waits for it to become healthy.
- The gateway's design. It gained a lifecycle — port fallback, a ready line, a
  stdin shutdown channel, a runtime state file — all inert unless
  `MERIDIAN_DESKTOP=1`.
- The CLI. `uag` gained the ability to *find* a running desktop instance through
  `instance.json`; nothing it did before behaves differently.
- Any provider, router or agent behaviour.

---

## Files

| | |
| --- | --- |
| `apps/desktop/src-tauri/src/` | the shell: `main.rs`, `gateway.rs`, `paths.rs`, `ports.rs`, `secret.rs`, `logs.rs` |
| `apps/desktop/shell/index.html` | the local splash and diagnostics page |
| `apps/desktop/runtime.json` | the pinned Node, by digest, in one place |
| `packages/shared/src/platform.ts` | per-OS paths, desktop detection, runtime state |
| `apps/gateway/src/desktop.ts` | port selection, ready line, state file, shutdown handlers |
| `scripts/fetch-node-runtime.mjs` | download and verify the runtime and its licence |
| `scripts/package-desktop.mjs` | assemble the payload; refuse a wrong-platform addon |
| `scripts/verify-desktop-payload.mjs` | boot it and prove it |
| `scripts/package-portable.mjs` | the archive build, with its own zip writer |
| `scripts/sign-windows.mjs` | the Authenticode hook |
| `.github/workflows/windows-desktop.yml` | the only job that can answer for Windows |

Documentation: [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md) ·
[DEVELOPMENT_WINDOWS.md](DEVELOPMENT_WINDOWS.md) ·
[RELEASE_WINDOWS.md](RELEASE_WINDOWS.md)

---

## Honest summary

The code is complete and the verification that a Linux machine can perform has
been performed and is reproducible. The Windows-only half — installer build,
silent install, upgrade, uninstall, orphan behaviour on a real Windows box — is
implemented and specified as CI steps that fail the build, and **has not yet
been run**. Until that workflow runs green, the correct statement is "built and
ready to be verified on Windows", not "verified on Windows".
