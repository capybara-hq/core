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
