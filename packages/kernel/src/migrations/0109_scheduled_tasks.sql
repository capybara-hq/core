-- Scheduled tasks (spec 2026-11-11-scheduled-tasks-design.md §4).
-- A task belongs to its org; the creator, agent and target conversation carry no foreign key: when
-- they go, the fire job pauses the task with a reason (creator_inactive / agent_gone /
-- conversation_gone) instead of the row vanishing.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  agent_id text NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  -- { kind: 'cron', expr, timeZone } or { kind: 'once', at, timeZone }; timeZone is an IANA name
  trigger jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('new', 'conversation', 'chat')),
  -- conversation mode only
  conversation_id text,
  -- chat mode only: { connectionId, chatId, chatType }
  chat jsonb,
  -- null = the agent's defaults
  model text,
  effort text,
  -- null = the default pick for new conversations
  device_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  pause_reason text CHECK (pause_reason IN ('creator', 'admin', 'failures', 'creator_inactive',
    'agent_gone', 'target_gone', 'conversation_gone', 'org_disabled', 'expired')),
  paused_by text,
  -- null when not active; jitter included
  next_run_at timestamptz,
  jitter_seconds integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- the scanner's due query
CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (next_run_at)
  WHERE status = 'active' AND deleted_at IS NULL;
-- a creator's list and the per-member cap
CREATE INDEX IF NOT EXISTS scheduled_tasks_account_idx ON scheduled_tasks (org_id, account_id)
  WHERE deleted_at IS NULL;

-- One row per tick (and per trial run). scheduled_for is the tick before jitter.
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  fired_at timestamptz,
  trial boolean NOT NULL DEFAULT false,
  conversation_id text,
  run_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  skip_reason text CHECK (skip_reason IN ('missed', 'overlap', 'rate_limited', 'queue_paused',
    'removed', 'device_offline', 'creator_inactive', 'agent_gone', 'target_gone',
    'conversation_gone', 'org_disabled')),
  error text,
  -- tool keys refused for lack of a grant (§7)
  missing_grants jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- the exactly-once guard: one scheduled run per tick (trial runs are free of it)
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_task_runs_tick_uq ON scheduled_task_runs (task_id, scheduled_for)
  WHERE NOT trial;
-- a task's history and its latest run
CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_idx ON scheduled_task_runs (task_id, scheduled_for DESC);
-- the org's maxRunsPerHour count
CREATE INDEX IF NOT EXISTS scheduled_task_runs_fired_idx ON scheduled_task_runs (org_id, fired_at)
  WHERE fired_at IS NOT NULL;

-- A task's "always allow" grants: the shape and meaning of conversation_tool_grants (a grant stops
-- applying when spec_hash changes or the connector is not the same one).
CREATE TABLE IF NOT EXISTS scheduled_task_grants (
  task_id text NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  tool_key text NOT NULL,
  spec_hash text NOT NULL,
  connector_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, tool_key)
);

-- Marks a run as unattended and links it to its task run; inherited by the runs that descend from
-- it without a person (sub-agents, wakes caused by an unattended run).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS scheduled_task_run_id text;
-- Set on the conversations a new-mode task creates.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS scheduled_task_id text;
CREATE INDEX IF NOT EXISTS conversations_scheduled_task_idx ON conversations (scheduled_task_id)
  WHERE scheduled_task_id IS NOT NULL;
-- The schedule marker of a queued task message (ScheduleMarker); null for a person's message.
ALTER TABLE conversation_queue ADD COLUMN IF NOT EXISTS schedule jsonb;
