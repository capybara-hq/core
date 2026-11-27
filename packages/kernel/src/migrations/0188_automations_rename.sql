-- Scheduled tasks become automations (collaboration spec 2026-11-25 §4.1; no compatibility before
-- 0.1.0): the tables, their columns, indexes and constraints, and the columns that point at them
-- take the new names, and the mutable state that names the feature is rewritten once, here:
-- - the push category `schedules` (the CHECK of 0172 and the stored preferences) → `automations`;
-- - the org settings group `scheduledTasks` → `automations` (its `forbiddenTools` in new keys);
-- - audit actions `schedule.*` → `automation.*`;
-- - the builtin tool keys `ScheduleCreate`, `ScheduleUpdate`, `ScheduleList`, `ScheduleTargets`
--   and `ScheduleDelete` → `Automation*`, in tool grants, an automation's grants, pending
--   approvals and questions, and stored agent definitions and agent templates (the pattern of
--   0063 and 0139: only tool key positions, never prose);
-- - pending outbox rows: the jobs `sched-fire` / `sched-settle` → `automation-fire` /
--   `automation-settle` with their ids, and push jobs of an automation run (`sched-<taskRunId>`
--   event ids, source kind `schedule`) → `automation-<taskRunId>`, kind `automation`.
-- Logs and recordings are never rewritten (as in 0063): the event log keeps its frozen names
-- (`user_message.schedule`, `run_started.trigger = 'schedule'`), and so does the
-- `conversation_queue.schedule` column that carries the frozen marker. Decided approvals and
-- answered questions are history and stay. Not migrated (pre-0.1.0, no compatibility layer):
-- - pending push deliveries keep `message.threadId` `schedule-<taskId>` (it only groups
--   notifications on the device);
-- - jobs already handed to Redis under the old names, and pending Platform-tool approvals that name
--   a `schedules.*` operation;
-- - deployment config: a deployment renames its `schedules.*` config (env `CAPYBARA_SCHEDULES__*`,
--   config file or Nacos) to `automations.*` itself.
--
-- `automation_grants` has no `org_id`, so, like `scheduled_task_grants` before it, it gets no RLS
-- policy (RLS spec §6, child tables); the `org_scope` policies of 0182 follow their tables through
-- the rename and are stated again under the new names. Idempotent: a second run matches nothing it could change.

-- capybara:allow-destructive table rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS scheduled_tasks RENAME TO automations;
-- capybara:allow-destructive table rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS scheduled_task_runs RENAME TO automation_runs;
-- capybara:allow-destructive table rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS scheduled_task_grants RENAME TO automation_grants;

-- Column and constraint renames: RENAME COLUMN / RENAME CONSTRAINT take no IF EXISTS, so each runs
-- only while its old name is there.
-- capybara:allow-destructive column and constraint renames; the kernel code is renamed in the same release (project not released, no compatibility layer)
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('automation_runs', 'task_id', 'automation_id'),
    ('automation_grants', 'task_id', 'automation_id'),
    ('runs', 'scheduled_task_run_id', 'automation_run_id'),
    ('conversations', 'scheduled_task_id', 'automation_id')
  ) AS m(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = c.tbl
                 AND column_name = c.old_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', c.tbl, c.old_name, c.new_name);
    END IF;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES
    ('automations', 'scheduled_tasks_org_id_fkey', 'automations_org_id_fkey'),
    ('automations', 'scheduled_tasks_mode_check', 'automations_mode_check'),
    ('automations', 'scheduled_tasks_status_check', 'automations_status_check'),
    ('automations', 'scheduled_tasks_pause_reason_check', 'automations_pause_reason_check'),
    ('automation_runs', 'scheduled_task_runs_task_id_fkey', 'automation_runs_automation_id_fkey'),
    ('automation_runs', 'scheduled_task_runs_org_id_fkey', 'automation_runs_org_id_fkey'),
    ('automation_runs', 'scheduled_task_runs_status_check', 'automation_runs_status_check'),
    ('automation_runs', 'scheduled_task_runs_skip_reason_check',
      'automation_runs_skip_reason_check'),
    ('automation_grants', 'scheduled_task_grants_task_id_fkey',
      'automation_grants_automation_id_fkey')
  ) AS m(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint k
               JOIN pg_class t ON t.oid = k.conrelid
               WHERE t.relnamespace = current_schema()::regnamespace AND t.relname = c.tbl
                 AND k.conname = c.old_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', c.tbl, c.old_name, c.new_name);
    END IF;
  END LOOP;
END
$$;

-- Indexes (a primary key's index renames its constraint with it).
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_tasks_pkey RENAME TO automations_pkey;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_tasks_due_idx RENAME TO automations_due_idx;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_tasks_account_idx RENAME TO automations_account_idx;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_runs_pkey RENAME TO automation_runs_pkey;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_runs_tick_uq RENAME TO automation_runs_tick_uq;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_runs_pending_idx RENAME TO automation_runs_pending_idx;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_runs_task_idx RENAME TO automation_runs_automation_idx;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_runs_fired_idx RENAME TO automation_runs_fired_idx;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS scheduled_task_grants_pkey RENAME TO automation_grants_pkey;
-- capybara:allow-destructive index rename; the kernel code is renamed in the same release (project not released, no compatibility layer)
ALTER INDEX IF EXISTS conversations_scheduled_task_idx RENAME TO conversations_automation_idx;

-- The `org_scope` policies of 0182 followed their tables through the rename; stated again under
-- the new names (still dark: nothing enables row level security before phase 5).
DROP POLICY IF EXISTS org_scope ON automations;
CREATE POLICY org_scope ON automations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
DROP POLICY IF EXISTS org_scope ON automation_runs;
CREATE POLICY org_scope ON automation_runs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- The push category: the CHECK of 0172 is replaced (drop and add in this file's one transaction),
-- the stored preferences follow.
ALTER TABLE push_preferences DROP CONSTRAINT IF EXISTS push_preferences_category_check;
-- capybara:allow-destructive rewrites the category in place; no kernel version reads the old name
UPDATE push_preferences SET category = 'automations' WHERE category = 'schedules';
ALTER TABLE push_preferences ADD CONSTRAINT push_preferences_category_check
  CHECK (category IN ('waiting', 'replies', 'tasks', 'automations'));

-- The new key of builtin tool key `k` (every other key as it is).
CREATE OR REPLACE FUNCTION pg_temp.automation_tool_key(k text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE k
    WHEN 'ScheduleCreate' THEN 'AutomationCreate'
    WHEN 'ScheduleUpdate' THEN 'AutomationUpdate'
    WHEN 'ScheduleList' THEN 'AutomationList'
    WHEN 'ScheduleTargets' THEN 'AutomationTargets'
    WHEN 'ScheduleDelete' THEN 'AutomationDelete'
    ELSE k
  END
$fn$;

-- A list of tool keys in new keys, in order; other values (and a non-list) as they are.
CREATE OR REPLACE FUNCTION pg_temp.automation_key_list(l jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(l) IS DISTINCT FROM 'array' THEN l ELSE coalesce((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(x.e) = 'string'
        THEN to_jsonb(pg_temp.automation_tool_key(x.e #>> '{}')) ELSE x.e END
      ORDER BY x.ord)
    FROM jsonb_array_elements(l) WITH ORDINALITY AS x(e, ord)), '[]'::jsonb) END
$fn$;

-- `toolPolicies` (an object keyed by tool key) in new keys.
CREATE OR REPLACE FUNCTION pg_temp.automation_policies(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN p ELSE coalesce((
    SELECT jsonb_object_agg(pg_temp.automation_tool_key(e.key), e.value)
    FROM jsonb_each(p) AS e), '{}'::jsonb) END
$fn$;

-- `disabledTools` (tools default-on spec §2): a builtin entry names its tool by key; extension and
-- connector entries name their own tools and stay.
CREATE OR REPLACE FUNCTION pg_temp.automation_disabled(l jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(l) IS DISTINCT FROM 'array' THEN l ELSE coalesce((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(x.e) = 'object' AND x.e ->> 'kind' = 'builtin'
             AND jsonb_typeof(x.e -> 'name') = 'string'
        THEN jsonb_set(x.e, '{name}', to_jsonb(pg_temp.automation_tool_key(x.e ->> 'name')))
        ELSE x.e END
      ORDER BY x.ord)
    FROM jsonb_array_elements(l) WITH ORDINALITY AS x(e, ord)), '[]'::jsonb) END
$fn$;

-- A template-shaped value (an agent template, an inline sub-agent, an agent definition) in new keys.
CREATE OR REPLACE FUNCTION pg_temp.automation_template(t jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(t) IS DISTINCT FROM 'object' THEN t ELSE t
    || CASE WHEN t ? 'tools'
         THEN jsonb_build_object('tools', pg_temp.automation_key_list(t -> 'tools'))
         ELSE '{}'::jsonb END
    || CASE WHEN t ? 'disallowedTools'
         THEN jsonb_build_object('disallowedTools',
           pg_temp.automation_key_list(t -> 'disallowedTools'))
         ELSE '{}'::jsonb END
    || CASE WHEN t ? 'toolPolicies'
         THEN jsonb_build_object('toolPolicies', pg_temp.automation_policies(t -> 'toolPolicies'))
         ELSE '{}'::jsonb END
    || CASE WHEN t ? 'disabledTools'
         THEN jsonb_build_object('disabledTools',
           pg_temp.automation_disabled(t -> 'disabledTools'))
         ELSE '{}'::jsonb END
  END
$fn$;

-- An agent definition or an agent template in new keys: its own keys and those of its inline
-- sub-agent templates.
CREATE OR REPLACE FUNCTION pg_temp.automation_definition(d jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT pg_temp.automation_template(d) || CASE
    WHEN jsonb_typeof(d -> 'subagents' -> 'inline') = 'array' THEN jsonb_build_object(
      'subagents',
      jsonb_set(d -> 'subagents', '{inline}', (
        SELECT coalesce(jsonb_agg(pg_temp.automation_template(x.e) ORDER BY x.ord), '[]'::jsonb)
        FROM jsonb_array_elements(d -> 'subagents' -> 'inline') WITH ORDINALITY AS x(e, ord))))
    ELSE '{}'::jsonb
  END
$fn$;

-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE agent_versions
SET definition = pg_temp.automation_definition(definition)
WHERE pg_temp.automation_definition(definition) <> definition;

-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE agent_template_versions
SET definition = pg_temp.automation_definition(definition)
WHERE pg_temp.automation_definition(definition) <> definition;

-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE platform_agent_template_versions
SET definition = pg_temp.automation_definition(definition)
WHERE pg_temp.automation_definition(definition) <> definition;

-- The org settings group moves to `automations`; its `forbiddenTools` (tool keys) in new keys.
-- capybara:allow-destructive moves the settings group in place; no kernel version reads the old key
UPDATE orgs
SET settings = (settings - 'scheduledTasks') || jsonb_build_object('automations',
  CASE WHEN jsonb_typeof(settings -> 'scheduledTasks') = 'object'
         AND settings -> 'scheduledTasks' ? 'forbiddenTools'
    THEN jsonb_set(settings -> 'scheduledTasks', '{forbiddenTools}',
      pg_temp.automation_key_list(settings -> 'scheduledTasks' -> 'forbiddenTools'))
    ELSE settings -> 'scheduledTasks' END)
WHERE jsonb_typeof(settings) = 'object' AND settings ? 'scheduledTasks';

-- Grants: a grant whose new key already exists for the same owner stays as it is (the primary key).
-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE tool_grants g
SET tool_key = pg_temp.automation_tool_key(g.tool_key)
WHERE pg_temp.automation_tool_key(g.tool_key) <> g.tool_key
  AND NOT EXISTS (
    SELECT 1 FROM tool_grants x
    WHERE x.org_id = g.org_id AND x.account_id = g.account_id AND x.agent_id = g.agent_id
      AND x.tool_key = pg_temp.automation_tool_key(g.tool_key)
  );

-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE conversation_tool_grants g
SET tool_key = pg_temp.automation_tool_key(g.tool_key)
WHERE pg_temp.automation_tool_key(g.tool_key) <> g.tool_key
  AND NOT EXISTS (
    SELECT 1 FROM conversation_tool_grants x
    WHERE x.conversation_id = g.conversation_id
      AND x.tool_key = pg_temp.automation_tool_key(g.tool_key)
  );

-- capybara:allow-destructive rewrites builtin tool keys in place; no kernel version reads the old keys
UPDATE automation_grants g
SET tool_key = pg_temp.automation_tool_key(g.tool_key)
WHERE pg_temp.automation_tool_key(g.tool_key) <> g.tool_key
  AND NOT EXISTS (
    SELECT 1 FROM automation_grants x
    WHERE x.automation_id = g.automation_id
      AND x.tool_key = pg_temp.automation_tool_key(g.tool_key)
  );

-- capybara:allow-destructive rewrites tool keys of pending approvals in place (resumed by run and call id, never by key)
UPDATE approvals
SET tool_key = pg_temp.automation_tool_key(tool_key)
WHERE status = 'pending' AND pg_temp.automation_tool_key(tool_key) <> tool_key;

-- capybara:allow-destructive rewrites tool keys of pending questions in place (resumed by run and call id, never by key)
UPDATE questions
SET spec = jsonb_set(spec, '{toolKey}', to_jsonb(pg_temp.automation_tool_key(spec ->> 'toolKey')))
WHERE status = 'pending' AND jsonb_typeof(spec -> 'toolKey') = 'string'
  AND pg_temp.automation_tool_key(spec ->> 'toolKey') <> spec ->> 'toolKey';

DROP FUNCTION IF EXISTS pg_temp.automation_definition(jsonb);
DROP FUNCTION IF EXISTS pg_temp.automation_template(jsonb);
DROP FUNCTION IF EXISTS pg_temp.automation_disabled(jsonb);
DROP FUNCTION IF EXISTS pg_temp.automation_policies(jsonb);
DROP FUNCTION IF EXISTS pg_temp.automation_key_list(jsonb);
DROP FUNCTION IF EXISTS pg_temp.automation_tool_key(text);

-- capybara:allow-destructive renames audit actions in place; no kernel version reads the old names
UPDATE audit_events
SET action = 'automation.' || substr(action, length('schedule.') + 1)
WHERE action LIKE 'schedule.%';

-- Pending outbox rows (dead ones too, so a retry by hand still finds its handler): the
-- automation jobs and their ids (`sched-fire-<taskRunId>`, `sched-settle-<taskRunId>[-…]`).
-- capybara:allow-destructive renames owed jobs in place; no kernel version handles the old names
UPDATE outbox
SET job_name = 'automation-fire',
    job_id = 'automation-fire-' || substr(job_id, length('sched-fire-') + 1)
WHERE job_name = 'sched-fire' AND job_id LIKE 'sched-fire-%';

-- capybara:allow-destructive renames owed jobs in place; no kernel version handles the old names
UPDATE outbox
SET job_name = 'automation-settle',
    job_id = 'automation-settle-' || substr(job_id, length('sched-settle-') + 1)
WHERE job_name = 'sched-settle' AND job_id LIKE 'sched-settle-%';

-- Push jobs of an automation run: the event id `sched-<taskRunId>` becomes
-- `automation-<taskRunId>`, in the fanout's id and data (source kind `schedule` → `automation`)
-- and in each delivery's id and data.
-- capybara:allow-destructive renames owed push jobs in place; no kernel version reads the old source kind
UPDATE outbox
SET job_id = 'push-fanout-automation-' || substr(job_id, length('push-fanout-sched-') + 1),
    data = jsonb_set(
      jsonb_set(data, '{eventId}',
        to_jsonb('automation-' || substr(data ->> 'eventId', length('sched-') + 1))),
      '{source,kind}', '"automation"'::jsonb)
WHERE queue = 'cap-push-deliver' AND job_name = 'push-fanout'
  AND job_id LIKE 'push-fanout-sched-%' AND data -> 'source' ->> 'kind' = 'schedule';

-- capybara:allow-destructive renames owed push jobs in place; no kernel version reads the old event ids
UPDATE outbox
SET job_id = 'push-automation-' || substr(job_id, length('push-sched-') + 1),
    data = jsonb_set(data, '{eventId}',
      to_jsonb('automation-' || substr(data ->> 'eventId', length('sched-') + 1)))
WHERE queue = 'cap-push-deliver' AND job_name = 'push-deliver'
  AND job_id LIKE 'push-sched-%' AND data ->> 'eventId' LIKE 'sched-%';
