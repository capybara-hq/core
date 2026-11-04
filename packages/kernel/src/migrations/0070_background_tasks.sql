-- Background Bash (spec 2026-11-05-background-bash-design §4.1): a command started with
-- run_in_background keeps running in the conversation's sandbox after its tool call returns. One
-- row per task; the owner is `conversation_id` (the child conversation for a sub-agent) and
-- `sandbox_conversation_id` is the root conversation that owns the sandbox. Rows go with their
-- conversations; finished rows are pruned after tools.outputRetentionDays.
CREATE TABLE IF NOT EXISTS capybara.background_tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  sandbox_conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  call_id text NOT NULL,
  trigger_account_id text NOT NULL,
  description text NOT NULL,
  command text NOT NULL,
  -- the session id: the pid `setsid` started; stopping and liveness go by the session
  sid text NOT NULL,
  -- relative to /workspace
  output_path text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'timed_out', 'lost')),
  lost_reason text,
  exit_code integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deadline_at timestamptz NOT NULL,
  -- the sandbox instance the task runs in (the handle plus created_at identify an instance)
  sandbox_created_at timestamptz NOT NULL,
  -- a task marked lost while its process may still exist
  kill_pending boolean NOT NULL DEFAULT false,
  -- the bytes TaskOutput has already returned
  read_offset bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS background_tasks_running_idx
  ON capybara.background_tasks (sandbox_conversation_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS background_tasks_conversation_idx
  ON capybara.background_tasks (conversation_id, started_at DESC);
