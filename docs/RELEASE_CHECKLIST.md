# Meridian release checklist

Repeatable commands, in the order a release runs them. Every step either passes,
fails, or names the external dependency it needs — there is no fourth outcome
and nothing here is ticked by hand.

The single command is:

```bash
pnpm verify:production
```

It writes `docs/evidence/RELEASE.md` (for people) and `release-readiness.json`
(for pipelines) from the run, and exits non-zero if any gate FAILED. The rest of
this document is what it does, what it cannot do here, and what a human must do
before tagging.

---

## 0. Clean room

Start from a fresh checkout, not from a working tree you have been editing. The
freshness gates compare artefacts against source, and a dirty tree can make a
stale artefact look current.

```bash
git clone https://github.com/jyoung2000/Gdg meridian-release && cd meridian-release
corepack enable && pnpm install --frozen-lockfile
```

## 1. Version

One version, everywhere: every workspace manifest, the Rust crate,
`MERIDIAN_VERSION`, and the Tauri bundle.

```bash
node scripts/check-version.mjs          # fails on any disagreement
node scripts/check-version.mjs --write  # make them agree after a bump
```

A prerelease (`1.0.0-rc.1`) is carried everywhere **except** the Tauri bundle: a
Windows MSI encodes a version as three integers and has nowhere to put `-rc.1`,
so the installer carries the release train's base version. The gate knows this
and says so; it is not drift.

## 2. Static checks

```bash
pnpm lint
pnpm typecheck
pnpm build            # gateway + CLI bundles, web client
node scripts/check-dependencies.mjs   # fails on a high or critical advisory
```

## 3. Tests

```bash
pnpm test             # every suite
pnpm test:unit        # or one at a time
pnpm test:router
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:ui          # real Chromium
pnpm test:chaos       # concurrency and budget races
```

Skips are legitimate only when they name an external dependency. A skip with no
reason is a failure that has not been noticed yet.

## 4. Offline artefacts

The GUI mockup, the offline UI and the seven preview screenshots are release
artefacts and go stale silently.

```bash
pnpm build && pnpm mockup && pnpm build:offline-ui
node scripts/check-offline-ui.mjs     # refuses a stale or non-self-contained artefact
```

## 5. Evidence

```bash
node scripts/scorecard.mjs --check    # the shipped report matches the matrices
node scripts/scorecard.mjs --write    # regenerate it after changing a matrix
pnpm verify:release                   # writes docs/evidence/RELEASE.md
```

## 6. Docker — needs a daemon and registry access

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps
curl -fsS http://localhost:4639/api/system/health
docker compose restart && curl -fsS http://localhost:4639/api/system/health
docker compose down
```

Then the sandbox, which is the part worth actually attacking rather than reading:

```bash
pnpm sandbox:image
MERIDIAN_SANDBOX=docker pnpm test:e2e   # the container isolation cases stop skipping
```

## 7. Windows — needs a Windows runner

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:runtime      # fetch the bundled Node runtime
pnpm package:windows      # NSIS + MSI
pnpm desktop:verify       # payload completeness, including every migration
```

Install the produced installer on a clean machine, then check: first launch,
tray, dynamic port selection, credential storage, restart, upgrade over the
previous version, uninstall, and that user data survives an upgrade.

Signing is configured but unsigned without a certificate. An unsigned build is
an unsigned build; do not describe it otherwise.

## 8. Live providers — needs credentials

Real, authenticated, deliberately tiny requests. Never run without a ceiling.

```bash
export MERIDIAN_LIVE_TESTS=1
export ALLOW_PAID_LIVE_TESTS=true
export LIVE_TEST_MAX_COST_USD=1.00
pnpm test:live
pnpm verify:providers
```

## 9. Backup and restore

Not yet automated. The drill, which a release should perform at least once:

```bash
# Back up: SQLite's own consistent copy, not `cp` on a live database.
sqlite3 "$MERIDIAN_DB" ".backup '/backup/meridian-$(date +%F).db'"

# Restore into a clean data directory and start against it.
mkdir -p /restore && cp /backup/meridian-YYYY-MM-DD.db /restore/meridian.db
MERIDIAN_DB=/restore/meridian.db MERIDIAN_DATA_DIR=/restore pnpm start
```

Then confirm from the running instance: workspaces list, credentials decrypt,
usage history is present, and `_migrations` is at the expected count. A backup
nobody has restored is not a backup.

## 10. Tag

Only once §1–§5 pass locally and §6–§8 pass wherever their dependency exists.

```bash
git tag -a v1.0.0-rc.1 -m "Meridian 1.0.0-rc.1"
git push origin v1.0.0-rc.1     # CI builds the Windows installer and attaches artefacts
```

Promote `1.0.0-rc.1` to `1.0.0` only when Docker, Windows and live-provider
verification have each been run somewhere that can run them, and recorded.
