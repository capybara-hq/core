-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): event fields every
-- current writer sets are required, so rows logged before a field existed get it once, here (the
-- log and the events in eval case snapshots). Idempotent: a second run matches nothing.
--
-- - `compaction_summary.savedTokens`: 0 (the web shows the plain divider, as for "nothing saved").
-- - `compaction_summary.step` / `compaction_failed.step`: the step of the compaction usage the same
--   run logged with it (the first `usage` with `purpose: "compaction"` after it), else 0. Only a
--   later compaction of the same run and step reads it (its idempotency ordinal); those runs ended.
-- - `approval_requested.requestedFor` / `.approverRole`: from the approval row, else null.
--
-- Cost: one pass over `conversation_events` filtered by type (and over `eval_cases`), done once;
-- release-candidate-sized tables, as earlier event rewrites (0105) assumed.

-- The compaction event `e` (seq `s` of run `r` in conversation `c`) with its missing step.
CREATE OR REPLACE FUNCTION pg_temp.with_step(p jsonb, c text, r text, s bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT p || jsonb_build_object('step', coalesce((
    SELECT (u.payload ->> 'step')::int FROM conversation_events u
    WHERE u.conversation_id = c AND u.run_id IS NOT DISTINCT FROM r AND u.seq > s
      AND u.type = 'usage' AND u.payload ->> 'purpose' = 'compaction'
      AND jsonb_typeof(u.payload -> 'step') = 'number'
    ORDER BY u.seq LIMIT 1), 0))
$fn$;

-- The approval payload `p` with its approver fields from the approval row.
CREATE OR REPLACE FUNCTION pg_temp.with_approver(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object(
      'requestedFor', CASE WHEN p ? 'requestedFor' THEN p -> 'requestedFor'
        ELSE coalesce(to_jsonb(a.requested_for), 'null'::jsonb) END,
      'approverRole', CASE WHEN p ? 'approverRole' THEN p -> 'approverRole'
        ELSE coalesce(to_jsonb(a.approver_role), 'null'::jsonb) END) || (p - 'requestedFor' - 'approverRole')
  FROM (SELECT 1) AS one
  LEFT JOIN approvals a ON a.id::text = p ->> 'approvalId'
$fn$;

UPDATE conversation_events
SET payload = payload || '{"savedTokens": 0}'::jsonb
WHERE type = 'compaction_summary' AND NOT payload ? 'savedTokens';

UPDATE conversation_events
SET payload = pg_temp.with_step(payload, conversation_id, run_id, seq)
WHERE type IN ('compaction_summary', 'compaction_failed') AND NOT payload ? 'step';

UPDATE conversation_events
SET payload = pg_temp.with_approver(payload)
WHERE type = 'approval_requested' AND NOT (payload ? 'requestedFor' AND payload ? 'approverRole');

-- Eval case snapshots: the same, on their events (a missing step there is 0: the snapshot's usage
-- events are in the same array, but a summary's step is never read from a snapshot).
UPDATE eval_cases AS c
SET snapshot = jsonb_set(c.snapshot, '{events}', (
  SELECT jsonb_agg(CASE
      WHEN e ->> 'type' = 'compaction_summary' OR e ->> 'type' = 'compaction_failed' THEN
        jsonb_set(e, '{payload}',
          CASE WHEN e ->> 'type' = 'compaction_summary' AND NOT (e -> 'payload') ? 'savedTokens'
            THEN '{"savedTokens": 0}'::jsonb ELSE '{}'::jsonb END
          || CASE WHEN NOT (e -> 'payload') ? 'step' THEN '{"step": 0}'::jsonb ELSE '{}'::jsonb END
          || (e -> 'payload'))
      WHEN e ->> 'type' = 'approval_requested' THEN
        jsonb_set(e, '{payload}', pg_temp.with_approver(e -> 'payload'))
      ELSE e END ORDER BY ord)
  FROM jsonb_array_elements(c.snapshot -> 'events') WITH ORDINALITY AS t(e, ord)))
WHERE jsonb_typeof(c.snapshot -> 'events') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot -> 'events') AS t(e)
    WHERE (e ->> 'type' = 'compaction_summary'
        AND NOT ((e -> 'payload') ? 'savedTokens' AND (e -> 'payload') ? 'step'))
      OR (e ->> 'type' = 'compaction_failed' AND NOT (e -> 'payload') ? 'step')
      OR (e ->> 'type' = 'approval_requested'
        AND NOT ((e -> 'payload') ? 'requestedFor' AND (e -> 'payload') ? 'approverRole')));

DROP FUNCTION IF EXISTS pg_temp.with_approver(jsonb);
DROP FUNCTION IF EXISTS pg_temp.with_step(jsonb, text, text, bigint);
