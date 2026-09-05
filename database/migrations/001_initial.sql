-- Meridian initial schema.
--
-- SQLite with WAL. One file, one volume mount, no operational surface — the
-- product is self-hosted and a single node, so a server database would add
-- deployment burden without buying anything. Every table that participates in
-- routing is also held in memory at runtime; this is the durable record.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  routing_mode      TEXT NOT NULL DEFAULT 'AUTO',
  privacy_mode      TEXT NOT NULL DEFAULT 'TRUSTED_ONLY',
  preferred_models  TEXT NOT NULL DEFAULT '[]',
  preferred_providers TEXT NOT NULL DEFAULT '[]',
  preferred_pool    TEXT,
  theme             TEXT NOT NULL DEFAULT 'system',
  reduce_motion     INTEGER NOT NULL DEFAULT 0,
  layout            TEXT NOT NULL DEFAULT '{}',
  allow_paid        INTEGER NOT NULL DEFAULT 0,
  max_cost_per_task REAL,
  updated_at        INTEGER NOT NULL
);

-- API keys for the OpenAI- and Anthropic-compatible surfaces. Only the hash is
-- stored: a leaked database must not yield working gateway keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL,
  repo_url       TEXT,
  branch         TEXT,
  privacy_mode   TEXT NOT NULL DEFAULT 'TRUSTED_ONLY',
  default_mode   TEXT NOT NULL DEFAULT 'AUTO',
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER
);

CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  descriptor   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- Operator overrides layered over the shipped catalog entry.
  trust        TEXT,
  base_url     TEXT,
  data_use     TEXT,
  verified_at  INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_pools (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'priority',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- Secrets are stored as AES-256-GCM ciphertext. The plaintext never appears in
-- this table, in a log, or in any response body.
CREATE TABLE IF NOT EXISTS credentials (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  scope           TEXT NOT NULL,
  source          TEXT NOT NULL,
  label           TEXT NOT NULL,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  pool_id         TEXT REFERENCES credential_pools(id) ON DELETE SET NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  enabled         INTEGER NOT NULL DEFAULT 1,
  hint            TEXT NOT NULL,
  ciphertext      TEXT,
  max_concurrency INTEGER,
  expires_at      INTEGER,
  last_used_at    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider_id, enabled);

CREATE TABLE IF NOT EXISTS models (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  family            TEXT,
  modalities        TEXT NOT NULL,
  capabilities      TEXT NOT NULL,
  context_length    INTEGER,
  max_output_tokens INTEGER,
  pricing           TEXT NOT NULL,
  discovered        INTEGER NOT NULL DEFAULT 0,
  deprecated        INTEGER NOT NULL DEFAULT 0,
  tags              TEXT NOT NULL DEFAULT '[]',
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

CREATE TABLE IF NOT EXISTS model_scores (
  model_id   TEXT PRIMARY KEY,
  coding     REAL,
  reasoning  REAL,
  general    REAL,
  tool_use   REAL,
  vision     REAL,
  stability  REAL,
  samples    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_performance (
  model_id          TEXT PRIMARY KEY,
  ttft_ms           REAL,
  latency_ms        REAL,
  p95_latency_ms    REAL,
  jitter_ms         REAL,
  tokens_per_second REAL,
  uptime            REAL,
  samples           INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id           TEXT PRIMARY KEY,
  model_id     TEXT NOT NULL,
  case_id      TEXT NOT NULL,
  dimension    TEXT NOT NULL,
  score        REAL NOT NULL,
  latency_ms   REAL NOT NULL,
  ttft_ms      REAL,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_per_second REAL,
  error        TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON benchmarks(model_id, at DESC);

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id           TEXT PRIMARY KEY,
  state                 TEXT NOT NULL,
  circuit               TEXT NOT NULL DEFAULT 'closed',
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  success_count         INTEGER NOT NULL DEFAULT 0,
  failure_count         INTEGER NOT NULL DEFAULT 0,
  latency_ms            REAL,
  error_rate            REAL NOT NULL DEFAULT 0,
  cooldown_until        INTEGER,
  last_checked_at       INTEGER,
  last_error_at         INTEGER,
  last_error            TEXT
);

CREATE TABLE IF NOT EXISTS inference_pools (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  strategy         TEXT NOT NULL,
  members          TEXT NOT NULL DEFAULT '[]',
  fallback_pool_id TEXT,
  max_concurrency  INTEGER,
  daily_budget     REAL,
  builtin          INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id               TEXT PRIMARY KEY,
  pool_id          TEXT NOT NULL REFERENCES inference_pools(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  start_at         INTEGER NOT NULL,
  end_at           INTEGER NOT NULL,
  max_concurrency  INTEGER NOT NULL,
  budget           REAL,
  fallback_pool_id TEXT,
  models           TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'scheduled',
  used             INTEGER NOT NULL DEFAULT 0,
  spend            REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_policies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  weights     TEXT NOT NULL DEFAULT '{}',
  filters     TEXT NOT NULL DEFAULT '{}',
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  role               TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  task_type          TEXT NOT NULL,
  preferred_mode     TEXT NOT NULL,
  pool               TEXT NOT NULL,
  tools              TEXT NOT NULL DEFAULT '[]',
  system_prompt      TEXT NOT NULL,
  max_steps          INTEGER NOT NULL DEFAULT 24,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  enabled            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT,
  title        TEXT NOT NULL,
  request      TEXT NOT NULL,
  status       TEXT NOT NULL,
  lane         TEXT,
  mode         TEXT NOT NULL DEFAULT 'AUTO',
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT,
  estimate     TEXT,
  usage        TEXT NOT NULL DEFAULT '{}',
  result       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_steps (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  role            TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  summary         TEXT,
  model_id        TEXT,
  provider_id     TEXT,
  latency_ms      REAL,
  usage           TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  files_touched   TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  fallback_events TEXT NOT NULL DEFAULT '[]',
  step_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_steps_task ON task_steps(task_id, step_order);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id     TEXT,
  name        TEXT NOT NULL,
  arguments   TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  duration_ms REAL NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls(task_id, at);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id      TEXT,
  title        TEXT NOT NULL,
  messages     TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id             TEXT PRIMARY KEY,
  at             INTEGER NOT NULL,
  request_id     TEXT NOT NULL,
  user_id        TEXT,
  workspace_id   TEXT,
  task_id        TEXT,
  agent_role     TEXT,
  provider_id    TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  credential_id  TEXT,
  pool_id        TEXT,
  modality       TEXT NOT NULL,
  task_type      TEXT NOT NULL,
  prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost           REAL NOT NULL DEFAULT 0,
  latency_ms     REAL NOT NULL DEFAULT 0,
  ttft_ms        REAL,
  success        INTEGER NOT NULL DEFAULT 1,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage(task_id);

CREATE TABLE IF NOT EXISTS quotas (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  window      TEXT NOT NULL,
  limit_value REAL NOT NULL,
  used        REAL NOT NULL DEFAULT 0,
  resets_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotas_subject ON quotas(subject, subject_id, window);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  workspace_id TEXT,
  modality     TEXT NOT NULL,
  status       TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  params       TEXT NOT NULL DEFAULT '{}',
  model_id     TEXT,
  provider_id  TEXT,
  assets       TEXT NOT NULL DEFAULT '[]',
  error        TEXT,
  progress     REAL NOT NULL DEFAULT 0,
  cost         REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generations_created ON generation_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id      TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);

-- Instance-wide key/value settings, including the encrypted-at-rest master key
-- salt and the operator's global toggles.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
