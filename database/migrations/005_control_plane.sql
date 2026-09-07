-- Browser, MCP and research control plane.

-- MCP server specs. Config is JSON; secret values are NOT in the JSON — they
-- live in mcp_secrets, referenced by handle, sealed by the SecretBox.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_secrets (
  handle TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_policies (
  id TEXT PRIMARY KEY,
  policy TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_presets (
  id TEXT PRIMARY KEY,
  preset TEXT NOT NULL
);

-- Browser profiles hold cookies and origin storage: sealed at rest.
CREATE TABLE IF NOT EXISTS browser_profiles (
  name TEXT PRIMARY KEY,
  state_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Research provenance: one row per extraction, failures included.
CREATE TABLE IF NOT EXISTS research_records (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_at ON research_records (at DESC);
