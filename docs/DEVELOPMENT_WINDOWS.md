# Building the Windows desktop application

This is for people working on Meridian. If you only want to run it, see
[INSTALL_WINDOWS.md](INSTALL_WINDOWS.md).

## What the desktop application actually is

Not a browser pointed at localhost, and not a second copy of Meridian. It is a
native shell that **owns** the gateway:

```
Meridian.exe  (Rust / Tauri 2)
  ├── picks a free port, starting at 4639
  ├── mints or unwraps the credential master key    (DPAPI on Windows)
  ├── spawns  runtime\node.exe  server\gateway\main.js
  ├── waits for the gateway to print  meridian-ready <port>
  ├── navigates its window to  http://127.0.0.1:<port>
  ├── writes  %LOCALAPPDATA%\Meridian\runtime\instance.json  so `uag` finds it
  └── on exit: shuts the gateway down, and kills it if it will not go
```

The window loads a **local** page first and only then navigates to the gateway.
That ordering is the reason a failed start shows a diagnostic screen with the
gateway's last words on it, rather than a blank window or a browser error.

The web client is served by the gateway, not bundled into the shell. Bundling it
would make the app a cross-origin client of its own gateway, which would mean
widening CORS and loosening the gateway's CSP for **every** deployment —
including the Docker one — to suit the desktop build. Same-origin is worth more
than the few milliseconds it costs.

## Prerequisites

| | |
| --- | --- |
| Node | 22.23.2 exactly — see `apps/desktop/runtime.json` |
| pnpm | 10.33.0 (`packageManager` in `package.json`) |
| Rust | stable, MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`) |
| Visual Studio Build Tools | "Desktop development with C++" — for `better-sqlite3` and for linking the shell |
| WebView2 | already present on Windows 11 and up-to-date Windows 10 |
| Windows SDK | only if you are code-signing (`signtool.exe`) |

**Node 22 is not a suggestion.** `better-sqlite3` is a native addon; Node 22 is
`NODE_MODULE_VERSION` 127, and the ABI of the addon installed by `pnpm install`
must match the runtime that gets bundled. Build with Node 24 and the installer
you produce fails at `require()` on every user's machine, with an error most
people would read as a corrupt download.

## Build it

```powershell
pnpm install
pnpm package:windows
```

That is four steps behind one name:

| Step | What it does | Fails when |
| --- | --- | --- |
| `scripts/build.mjs` | esbuild → `dist/gateway/main.js`, `dist/cli/uag.js`; Vite → `dist/web` | anything does not compile |
| `scripts/fetch-node-runtime.mjs` | downloads Node 22.23.2 and checks it against the SHA-256 in `runtime.json` | the digest does not match |
| `scripts/package-desktop.mjs` | assembles `apps/desktop/payload/` | the native addon is for the wrong platform |
| `tauri build` | compiles the shell, runs the sign hook, produces the NSIS installer | Rust or NSIS fails |

Then, for the archive build:

```powershell
pnpm package:portable
```

The installer lands in `apps/desktop/src-tauri/target/release/bundle/nsis/`,
the archive in `dist/portable/`.

## Check the payload without building an installer

```powershell
pnpm build:windows      # everything up to, but not including, tauri build
pnpm desktop:verify
```

`scripts/verify-desktop-payload.mjs` is the honest check: it boots the payload
with its own bundled runtime, from a temporary directory outside the checkout,
with `PATH` untouched — creates a database through the native addon, fetches
`/api/system/health` and `/`, and then asks it to stop over stdin. It reports
every step. It is what CI runs, and it is the difference between "the files are
there" and "it works".

Two of its results are worth understanding:

- **Readiness returns 503 on a fresh payload.** That is correct. A new install
  has no models, so it is live but not ready, and it says which of database,
  discovery and models is the reason. Gating the desktop launch on *readiness*
  would mean a first-time user waits forever for a state that only arrives after
  they add a provider; the shell gates on **liveness** for that reason.
- **`payload is a plausible size`** exists because the failure it catches is
  silent. A payload that has quietly grown to 700 MB means the node_modules
  allowlist stopped being an allowlist.

## Develop against it

```powershell
pnpm dev              # gateway :4639 + Vite :5173, no shell involved
pnpm desktop:dev      # the Rust shell, against an already-assembled payload
```

`desktop:dev` needs `apps/desktop/payload/` to exist — run `pnpm build:windows`
once first. Rust changes rebuild in seconds after the first compile; gateway
changes need `pnpm build && pnpm desktop:payload` to reach the payload.

## Tests

```powershell
pnpm test                                       # the whole suite (Linux and Windows)
pnpm exec tsx --test tests/unit/platform-paths.test.ts
pnpm exec tsx --test tests/unit/windows-runtime.test.ts
pnpm exec tsx --test tests/e2e/desktop-lifecycle.test.ts
cd apps/desktop/src-tauri && cargo test
```

The three named suites are the ones whose answers differ by platform — paths,
shells, process lifecycle. They are written so they can run **anywhere**: they
decide by platform argument rather than by `process.platform`, so a Windows bug
in path handling is caught on the Linux machine that introduced it. The
Windows CI job runs them again on Windows, where the answers are real.

`cargo test` covers the parts of the shell that are pure logic: port selection,
path resolution, secret redaction in the log writer. One of those tests exists
because `secret_at` sliced a `&str` on a byte index and panicked on any
non-ASCII text — which would have crashed the log writer on any Windows machine
whose user name is not English.

## The parts that were Unix-only

Found by audit, fixed, and pinned by `tests/unit/windows-runtime.test.ts`:

- **`spawn('/bin/sh', ['-lc', cmd])`** ran every agent command. On Windows that
  is `ENOENT`, reported as "Failed to start command" — with the gateway itself
  running fine, so nothing at startup explained it. `shellFor()` now picks Git
  for Windows' `bash.exe` when it is there (Meridian composes POSIX command
  lines, so a POSIX shell is the right answer) and falls back to `cmd.exe`.
- **`findWebRoot()`** looked relative to the current working directory. A
  shortcut launches with a cwd of anywhere; it now looks relative to the bundle
  first.
- **Migrations were read from `database/migrations` at boot** and were not in
  the payload at all. They are now shipped, and the lookup honours
  `MERIDIAN_MIGRATIONS_DIR` and payload-relative paths.
- **Paths were POSIX-joined.** `platformPaths()` uses `win32.join` when the
  target is Windows, so `%APPDATA%\Meridian` is built with backslashes even when
  the code deciding it runs on Linux.

## Cross-building

`scripts/package-desktop.mjs --platform win32 --arch x64` will assemble a
Windows payload on Linux, and it is useful for checking the packaging logic. It
cannot produce a shippable one: `node_modules/better-sqlite3` on a Linux machine
holds a Linux `.node`, and copying it into a Windows payload produces an
application that installs perfectly and then fails at `require()`.

The script reads the binary's magic bytes and refuses:

```
package-desktop: the native addon in this payload is elf, expected pe
```

and deletes what it built. The installer for Windows is built on Windows.

## Signing

`bundle.windows.signCommand` runs `scripts/sign-windows.mjs` against every
artefact. With no certificate configured it leaves the artefact unsigned and
says so on stderr; that is the correct outcome for a fork, a pull request and a
local build. See [RELEASE_WINDOWS.md](RELEASE_WINDOWS.md) for the release path.

Run `tauri build` **from the repository root** — the sign command's path is
relative to the working directory.

## Where things live at runtime

| | |
| --- | --- |
| `%APPDATA%\Meridian` | database, `master.key`, workspaces — the user's data |
| `%LOCALAPPDATA%\Meridian` | the program |
| `%LOCALAPPDATA%\Meridian\logs\meridian.log` | shell and gateway log, secrets redacted |
| `%LOCALAPPDATA%\Meridian\runtime\instance.json` | port, pid and URL, so `uag` finds a running instance |

Data and program are deliberately separate directories: an uninstall removes one
and must not touch the other.

## The master key

The shell mints a 32-byte key with `BCryptGenRandom`, wraps it with DPAPI
(`CryptProtectData`, `CRYPTPROTECT_UI_FORBIDDEN`) and stores it beside the
database as `master.key`. It is passed to the gateway **through the
environment**, never as an argument: command lines on Windows are readable by
any process on the machine through WMI.

It is not in the database, which is what makes a copied `meridian.db` useless on
another machine or under another Windows account.
