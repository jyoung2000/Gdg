-- AI control plane: skills, AI profiles, scoped assignments, model history.

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  skill TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_profiles (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One decision per (kind, target, scope, scopeId). The unique index is what
-- makes re-assigning replace rather than stack contradictory rules.
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_unique
  ON assignments (kind, target_id, scope, IFNULL(scope_id, ''));

-- Model change history, so "recently discovered" and "model updated" are
-- observed events rather than a guess made at render time.
CREATE TABLE IF NOT EXISTS model_changes (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  changes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_changes_at ON model_changes (at DESC);
CREATE INDEX IF NOT EXISTS idx_model_changes_model ON model_changes (model_id, at DESC);
