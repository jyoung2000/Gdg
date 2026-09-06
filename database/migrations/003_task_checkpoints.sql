-- Workspace snapshots taken before each step of a task.
--
-- A coding agent that cannot be undone is one the user has to supervise
-- character by character. Checkpoints make a step reversible, so a run can be
-- taken back to the state before a particular agent touched anything rather
-- than rejected wholesale.
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  step_id    TEXT,
  label      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  -- The snapshot itself: files, skipped paths and the change log, as JSON.
  snapshot   TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task ON task_checkpoints (task_id, at);
