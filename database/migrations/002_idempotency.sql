-- Idempotency records for replayed mutating requests.
--
-- A client that retries after a timeout must not be charged twice, start a
-- second agent task, or create a second credential. The key is scoped to the
-- caller and the exact route so one client's key can never replay another's
-- response, and the body hash catches a key reused for a different payload —
-- which is a client bug worth reporting, not a cache hit.
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  method      TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  body_hash   TEXT    NOT NULL,
  status      INTEGER,
  response    TEXT,
  state       TEXT    NOT NULL,          -- 'in_flight' | 'complete'
  created_at  INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (key, user_id, method, path)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency (created_at);
