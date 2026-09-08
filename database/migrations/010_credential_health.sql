-- Per-credential health and quota.
--
-- Split from the request-trace migration because it answers a different
-- question: not "what happened to this request" but "is this account still
-- usable". Both were written in the same pass; they are kept apart so either
-- can be reasoned about on its own.

-- Per-credential health, so one caller's bad key stops condemning a provider.
--
-- `provider_health` is keyed by provider alone, and the executor records every
-- failure against it. One user's revoked or exhausted key therefore produced an
-- `authentication_failed` that marked the PROVIDER unauthorized — for every
-- other user, whose keys were fine. A credential is the closest thing Meridian
-- has to an account, and its state belongs to it rather than to the provider it
-- happens to point at.
CREATE TABLE IF NOT EXISTS credential_health (
  credential_id     TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'unknown',
  last_success_at   INTEGER,
  last_failure_at   INTEGER,
  last_error_code   TEXT,
  last_error        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- When this credential may be tried again. A key that answered 429 with a
  -- Retry-After is not broken; it is busy, and the difference decides whether
  -- routing should avoid it for a minute or stop using it entirely.
  cooldown_until    INTEGER,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credential_health_provider ON credential_health(provider_id);

-- What a provider last told us about how much of an allowance is left.
--
-- The `quotas` table from migration 001 was never read or written by a single
-- line of TypeScript, and its subject/subject_id shape does not fit what
-- providers actually publish. This one is shaped after the headers: a window, a
-- limit, a remainder and a reset, recorded per credential because that is the
-- thing a provider meters.
--
-- Every column is nullable on purpose. A provider that publishes nothing leaves
-- them null, and null must never be read as "full" — the difference between
-- "we do not know" and "there is plenty" is the difference between routing
-- around an exhausted key and hammering it.
CREATE TABLE IF NOT EXISTS credential_quota (
  credential_id   TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  -- 'requests' or 'tokens': providers meter both, on separate budgets.
  dimension       TEXT NOT NULL,
  limit_value     INTEGER,
  remaining       INTEGER,
  -- Epoch ms when the window resets, when the provider says.
  resets_at       INTEGER,
  -- Where this came from, so a reader can tell a parsed header from a guess.
  source          TEXT NOT NULL,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (credential_id, dimension)
);
CREATE INDEX IF NOT EXISTS idx_credential_quota_provider ON credential_quota(provider_id);
