-- Computer agent sessions and their action history.

-- The config column holds the snapshot the session was started with — model,
-- backend, grounding, permissions and approval mode — so a completed run stays
-- auditable after the instance defaults change.
CREATE TABLE IF NOT EXISTS computer_sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  task TEXT NOT NULL,
  config TEXT NOT NULL,
  active_backend_id TEXT NOT NULL,
  active_model_id TEXT,
  step INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  user_id TEXT,
  workspace_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_computer_sessions_created ON computer_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_computer_sessions_user ON computer_sessions (user_id, created_at DESC);

-- Every action, including the ones that were denied or never ran: the record of
-- what an agent was refused is as important as what it did.
CREATE TABLE IF NOT EXISTS computer_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  action TEXT NOT NULL,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  screenshot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_computer_actions_session ON computer_actions (session_id, step);
