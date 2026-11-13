-- A chat task whose channel extension is disabled in the org skips its runs with `plugin_disabled`
-- (scheduled tasks spec §11), distinct from `target_gone`: the task stays active and recovers when
-- the extension is enabled again. Widening the inline CHECK of 0113 (PG's default name
-- scheduled_task_runs_skip_reason_check): drop and add in the file's one transaction, idempotent.
ALTER TABLE scheduled_task_runs DROP CONSTRAINT IF EXISTS scheduled_task_runs_skip_reason_check;
ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_skip_reason_check
  CHECK (skip_reason IN ('missed', 'overlap', 'rate_limited', 'queue_paused',
    'removed', 'device_offline', 'creator_inactive', 'agent_gone', 'target_gone',
    'conversation_gone', 'org_disabled', 'unsupported_target', 'task_deleted', 'task_paused',
    'plugin_disabled'));
