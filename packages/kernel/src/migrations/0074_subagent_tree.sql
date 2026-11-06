-- Agent map (spec docs/superpowers/specs/2026-11-06-agent-map-design.md §6): nested sub-agents
-- and a budget per tree.
-- - conversations.subagent_depth: levels below the root conversation (0 = a root, 1 = its child).
-- - runs.budget_run_id: the person-triggered root run whose window this run's dispatches and its
--   descendants' tokens count against; null = the run is its own budget run.
-- - subagent_dispatches.budget_run_id: the budget run the dispatch counted against (existing rows:
--   the dispatching run, which was its own budget run before nesting).
-- - subagent_dispatches.for_skill: the dispatch of a `context: fork` skill invocation.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subagent_depth smallint NOT NULL DEFAULT 0;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS budget_run_id text;
CREATE INDEX IF NOT EXISTS runs_budget_run_idx ON runs (budget_run_id)
  WHERE budget_run_id IS NOT NULL;

ALTER TABLE subagent_dispatches ADD COLUMN IF NOT EXISTS budget_run_id text;
UPDATE subagent_dispatches SET budget_run_id = parent_run_id WHERE budget_run_id IS NULL;
ALTER TABLE subagent_dispatches ALTER COLUMN budget_run_id SET NOT NULL;
ALTER TABLE subagent_dispatches ADD COLUMN IF NOT EXISTS for_skill boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS subagent_dispatches_budget_run_idx
  ON subagent_dispatches (budget_run_id);

-- Org overrides stored in deployment_settings.subagentLimitOverrides ({orgId: {...}}): the limit
-- maxConcurrentPerRun is now maxConcurrentPerConversation (per conversation, §6). Each org entry
-- holding the old key gets the new key with its value instead; an entry that already has the new
-- key keeps it. Rows without the old key are left as they are, so a second run changes nothing.
UPDATE deployment_settings AS ds
SET value = (
  SELECT jsonb_object_agg(
    e.org,
    CASE
      WHEN jsonb_typeof(e.entry) = 'object' AND e.entry ? 'maxConcurrentPerRun'
        THEN jsonb_build_object('maxConcurrentPerConversation', e.entry -> 'maxConcurrentPerRun')
          || (e.entry - 'maxConcurrentPerRun')
      ELSE e.entry
    END
  )
  FROM jsonb_each(ds.value) AS e(org, entry)
)
WHERE ds.key = 'subagentLimitOverrides'
  AND jsonb_typeof(ds.value) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_each(ds.value) AS e(org, entry)
    WHERE jsonb_typeof(e.entry) = 'object' AND e.entry ? 'maxConcurrentPerRun'
  );
