-- The org's push policy for a connector's git hosts (sandbox git credentials spec §7): the
-- connector's virtual tool `git_push` (`allow` / `ask` / `deny`, default `ask`). It has no row in
-- `connector_tools` (that table mirrors the tools the connector serves, kept in step by drift
-- review), so it is the connector's own column. A member's standing allow for one repository is a
-- `connector_tool_account_policies` row named `git_push:<host>/<owner>/<repo>` (no schema change).
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS git_push_policy text NOT NULL DEFAULT 'ask';
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_git_push_policy_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_git_push_policy_check
  CHECK (git_push_policy IN ('allow', 'ask', 'deny'));

-- Run grants and the per-run caps read the git asks of a run tree.
CREATE INDEX IF NOT EXISTS approvals_git_run_idx ON approvals (run_id) WHERE kind = 'git';
