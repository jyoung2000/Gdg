-- Discovery pacing that survives a restart.
--
-- The scheduler's whole job is to be polite to other people's APIs: a minimum
-- interval between queries, exponential backoff after a failure, and a hard
-- pause once a provider has failed enough times in a row that something is
-- actually wrong. All of it lived in a Map, and a Map does not survive a
-- process.
--
-- So the pacing only worked for a gateway that stayed up. A crash loop, a
-- container restart policy, a desktop app the user quits and reopens, a
-- `docker compose restart` — each one cleared the backoff and the failure
-- pause together, and the next boot queried every provider immediately,
-- including the ones that had just rate-limited us six times. The worse a
-- provider was behaving, the more likely the restart, and the harder we hit it
-- on the way back up.
--
-- `scope` separates the two schedulers that exist: provider model discovery and
-- the free-inference dataset refresh. They pace different things at different
-- rates and must not share a row.
CREATE TABLE IF NOT EXISTS discovery_schedule (
  scope                TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  last_attempt_at      INTEGER,
  last_success_at      INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Absolute epoch ms, not a duration: a backoff that restarted its own clock
  -- on every boot would be no backoff at all.
  next_eligible_at     INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (scope, provider_id)
);
