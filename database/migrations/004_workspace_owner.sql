-- Who a workspace belongs to.
--
-- Workspaces were instance-wide, which is right for a single-user install and
-- wrong the moment authentication is turned on: a workspace holds source code,
-- and a workspace-scoped credential is reachable by anyone who can reach the
-- workspace. Ownership makes both answerable.
--
-- NULL means shared, which is what every workspace created before this
-- migration is. That is deliberate: silently reassigning existing workspaces to
-- whichever account happens to be first would be a worse answer than saying
-- they are shared.
ALTER TABLE workspaces ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id);
