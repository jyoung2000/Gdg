-- Which process is running a task, and when it last said so.
--
-- Boot reconciliation closes out tasks the database still calls running, on the
-- reasoning that a task executes in memory and therefore cannot outlive the
-- process that started it. That reasoning holds for exactly one process.
--
-- The same release deliberately supports more than one: the migration runner
-- takes an IMMEDIATE lock and a 30-second timeout precisely so that a Compose
-- file with two replicas, or a desktop app the user double-clicked twice, can
-- share a database. Against that, an unqualified reconciliation is destructive
-- — the second gateway to boot marks the first one's in-flight work failed,
-- broadcasts that to its clients, and the task keeps running and spending.
--
-- So a running task now carries a lease: who owns it, and when that owner last
-- proved it was alive. Reconciliation closes out only what has no live lease.
-- Both columns are nullable: rows written by an earlier build have neither, and
-- an unowned running task is exactly the stranded case this is meant to catch.
ALTER TABLE tasks ADD COLUMN owner_instance TEXT;
ALTER TABLE tasks ADD COLUMN heartbeat_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, heartbeat_at);
