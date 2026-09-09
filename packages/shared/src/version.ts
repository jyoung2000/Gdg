/**
 * The release this build is.
 *
 * One value, in one place. It used to be a string literal in about twenty
 * files — every workspace manifest, the Tauri bundle, the Cargo crate, the
 * MCP handshakes, and `GET /api/system/info`, which is the one a user reads
 * when they are trying to tell you which version they are running. Nothing
 * kept them equal, so "which version is this" had several answers.
 *
 * It is a checked-in constant rather than a read of `package.json` because the
 * gateway and CLI ship as bundles with no manifest beside them at runtime, and
 * a version that resolves differently depending on how the code was started is
 * worse than one that is written down. `scripts/check-version.mjs` is what
 * keeps it honest: it fails the release if this constant and any manifest
 * disagree, and `--write` propagates a new value everywhere at once.
 */
export const MERIDIAN_VERSION = '1.0.0';
