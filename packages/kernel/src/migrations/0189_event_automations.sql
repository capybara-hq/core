-- Event automations (collaboration spec 2026-11-25 §4.1, §4.5, §4.6): an automation fires on an
-- extension's trigger event as well as on a time trigger.
-- - `trigger_events`: the events extensions emit (`ctx.triggers.emit`), once per
--   (org, plugin, dedupe key);
-- - `automation_event_deliveries`: which event reached which automation, and the run that served
--   it (null while coalesced events wait for one, §4.7);
-- - `automation_conversations`: the one conversation per subject of a `subject`-mode automation;
-- - `automations` gains `origin`, `principal` and `unattended_ask`, and the `subject` mode;
-- - `automation_runs` is keyed by `trigger_key` (the tick as `Date.toISOString()` text for time
--   runs, the event id for event runs) instead of `scheduled_for`, which event runs leave null;
--   two skip reasons for event runs;
-- - `conversations.subject`, `runs.trigger_event_id` and `conversation_queue.automation_event`
--   (the queued message's event marker, logged as `user_message.automationEvent`).
-- Ids are text like every kernel id. The three new tables carry `org_id` and their `org_scope`
-- policies (still dark: nothing enables row level security before phase 5).

CREATE TABLE IF NOT EXISTS trigger_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- the emitting extension
  plugin text NOT NULL,
  type text NOT NULL,
  -- { kind, id, title, url? }
  subject jsonb NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL,
  dedupe_key text NOT NULL,
  -- a directed event: { accountId, agentId }; null = every matching automation
  audience jsonb,
  cause_account_id text,
  -- the run whose tool call emitted it (loop depth, §4.7)
  cause_run_id text,
  depth integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'dispatched', 'undelivered', 'depth_stopped')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trigger_events_dedupe_uq
  ON trigger_events (org_id, plugin, dedupe_key);

DROP POLICY IF EXISTS org_scope ON trigger_events;
CREATE POLICY org_scope ON trigger_events USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

CREATE TABLE IF NOT EXISTS automation_event_deliveries (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  automation_id text NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES trigger_events(id) ON DELETE CASCADE,
  -- `<subject kind>:<subject id>`: events of one subject coalesce into one run
  subject_key text NOT NULL,
  -- the run that served it; null while it waits for one
  automation_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, event_id)
);

-- the deliveries of a subject still waiting for a run
CREATE INDEX IF NOT EXISTS automation_event_deliveries_pending_idx
  ON automation_event_deliveries (automation_id, subject_key) WHERE automation_run_id IS NULL;

DROP POLICY IF EXISTS org_scope ON automation_event_deliveries;
CREATE POLICY org_scope ON automation_event_deliveries USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

CREATE TABLE IF NOT EXISTS automation_conversations (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  automation_id text NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  conversation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, subject_kind, subject_id)
);

DROP POLICY IF EXISTS org_scope ON automation_conversations;
CREATE POLICY org_scope ON automation_conversations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- Automations: who made it, whom it acts as (reserved for agent principals; null = `account_id`),
-- and what an unattended question does (null = the default).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'person';
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_origin_check;
ALTER TABLE automations ADD CONSTRAINT automations_origin_check
  CHECK (origin IN ('person', 'acceptance'));
ALTER TABLE automations ADD COLUMN IF NOT EXISTS principal jsonb;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS unattended_ask text;
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_unattended_ask_check;
ALTER TABLE automations ADD CONSTRAINT automations_unattended_ask_check
  CHECK (unattended_ask IN ('fail', 'wait'));

-- The mode CHECK of 0113 (renamed in 0188) gains `subject`: drop and add in this file's one
-- transaction.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_mode_check;
ALTER TABLE automations ADD CONSTRAINT automations_mode_check
  CHECK (mode IN ('new', 'conversation', 'chat', 'subject'));

-- Runs: the trigger key, backfilled from the tick as JS `Date.toISOString()` text, then required.
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_key text;
UPDATE automation_runs
SET trigger_key = to_char(scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE trigger_key IS NULL AND scheduled_for IS NOT NULL;
ALTER TABLE automation_runs ALTER COLUMN trigger_key SET NOT NULL;
ALTER TABLE automation_runs ALTER COLUMN scheduled_for DROP NOT NULL;
-- when the run was recorded: an event run has no tick, and `fired_at` is its claim (null until
-- the fire job claims it), so the run lists and the subject rate order and count by this
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- The exactly-once guard moves from the tick to the trigger key (trial runs stay free of it).
DROP INDEX IF EXISTS automation_runs_tick_uq;
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_trigger_uq
  ON automation_runs (automation_id, trigger_key) WHERE NOT trial;

-- The skip reason CHECK of 0128 (renamed in 0188) gains the event run reasons.
ALTER TABLE automation_runs DROP CONSTRAINT IF EXISTS automation_runs_skip_reason_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_skip_reason_check
  CHECK (skip_reason IN ('missed', 'overlap', 'rate_limited', 'queue_paused',
    'removed', 'device_offline', 'creator_inactive', 'agent_gone', 'target_gone',
    'conversation_gone', 'org_disabled', 'unsupported_target', 'task_deleted', 'task_paused',
    'plugin_disabled', 'not_visible', 'subject_rate'));

-- A conversation's subject ({ source, kind, id, title }, §4.5); the event behind a run; the event
-- marker of a queued automation message.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subject jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_event_id text;
ALTER TABLE conversation_queue ADD COLUMN IF NOT EXISTS automation_event jsonb;
