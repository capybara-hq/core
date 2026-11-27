-- Serializable trigger causes (collaboration spec 2026-11-25 §4.2, §4.7) and retention indexes.
-- - `trigger_cause_handles`: what `ctx.triggers.causeOf(call)` returns, so an extension can emit
--   from a queue job with `cause: { handle }` and keep the chain depth and the self-trigger check
--   of the tool call that queued it. A handle is bound to the org, the extension that asked for it
--   and the call's run (verified from the pipeline's call scope when it was made), with the depth
--   and trigger account the run had then (so the retention sweep deleting the run's trigger event
--   within the handle's life cannot restart the chain); `emit` accepts it only for an event of that
--   org from that extension before `expires_at` (24 hours on). The
--   trigger event sweep deletes expired handles. The table carries `org_id` and its `org_scope`
--   policy (still dark: nothing enables row level security before phase 5).
-- - `trigger_events_settled_idx` (0189) is rebuilt with the predicate the retention sweep queries
--   (`state IN (...)`), so the planner can use it.
-- - `inbox_items` gains the indexes of its retention (the same sweep, `inbox.retentionDays`).

CREATE TABLE IF NOT EXISTS trigger_cause_handles (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- the extension that asked for it; only it may emit with it
  plugin text NOT NULL,
  -- the run of the tool call it was made from (no foreign key, like trigger_events.cause_run_id)
  run_id text NOT NULL,
  -- the depth an event caused by the run gets, and the run's trigger account, at mint time
  depth integer NOT NULL,
  cause_account_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- the org's handles (an org's rows by org, as every org-scoped table)
CREATE INDEX IF NOT EXISTS trigger_cause_handles_org_idx
  ON trigger_cause_handles (org_id);

-- the sweep: expired handles
CREATE INDEX IF NOT EXISTS trigger_cause_handles_expires_idx
  ON trigger_cause_handles (expires_at);

DROP POLICY IF EXISTS org_scope ON trigger_cause_handles;
CREATE POLICY org_scope ON trigger_cause_handles
  USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP INDEX IF EXISTS trigger_events_settled_idx;
CREATE INDEX IF NOT EXISTS trigger_events_settled_idx
  ON trigger_events (created_at) WHERE state IN ('dispatched', 'undelivered', 'depth_stopped');

-- the inbox retention: items resolved, or past their expiry, long enough ago
CREATE INDEX IF NOT EXISTS inbox_items_resolved_idx
  ON inbox_items (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_items_expires_idx
  ON inbox_items (expires_at);
