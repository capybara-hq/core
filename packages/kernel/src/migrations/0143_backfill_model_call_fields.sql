-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): `model_call.request`
-- requires what the runtime always records, so `model_call` rows logged before a field existed
-- (development databases from before rc.0) get it once, here (the log and the events in eval case
-- snapshots), with the value the old readers assumed. Idempotent: a second run matches nothing.
--
-- - `absorbedUpToSeq`: the call's own seq (the old fallback: it took in everything before it).
-- - `tools`: [] with `toolsOmitted: true`, the flag reused here as "the set is unknown, skip it":
--   such a request carried no tools, and the tool-change notice skipped a call without recorded
--   tools, as it now skips a flagged one.
-- - `params`: {} (requests carried no parameters before they were recorded).
-- - `mediaBudgetBytes`, on a call that recorded `media` without it: the default
--   `attachments.requestMediaBytes` (20 MiB) of the time, an approximation (only step replay reads
--   it, and only for those calls).
-- - `maxOutputTokens` is not filled: every writer set it from the first `model_call` on.
--
-- Also `toolsOmitted: true` on current-format calls whose tools were left out for a model without
-- tool support before the flag existed: `tools` empty, no `catalog`, and a `reminder` of the same
-- run and step carrying the tools-unsupported text (the old tool-change notice inferred the omission
-- from that reminder; without the flag a resumed conversation would get a spurious "Your tools
-- changed"). Rows an old replica writes during a rolling deploy after this migration still lack the
-- flag (accepted before 0.1.0).
--
-- Cost: one pass over the `model_call` rows of `conversation_events` (plus a reminder lookup per
-- call with an empty tool list) and over `eval_cases`, done once; release-candidate-sized tables,
-- as earlier event rewrites (0105, 0142) assumed.

-- The request `r` of the model_call at seq `s` with its missing fields.
CREATE OR REPLACE FUNCTION pg_temp.with_request_fields(r jsonb, s bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT r
    || CASE WHEN r ? 'absorbedUpToSeq' THEN '{}'::jsonb
         ELSE jsonb_build_object('absorbedUpToSeq', s) END
    || CASE WHEN r ? 'tools' THEN '{}'::jsonb ELSE '{"tools": [], "toolsOmitted": true}'::jsonb END
    || CASE WHEN r ? 'params' THEN '{}'::jsonb ELSE '{"params": {}}'::jsonb END
    || CASE WHEN r ? 'media' AND NOT r ? 'mediaBudgetBytes'
         THEN '{"mediaBudgetBytes": 20971520}'::jsonb ELSE '{}'::jsonb END
$fn$;

-- Whether the request `r` lacks one of those fields.
CREATE OR REPLACE FUNCTION pg_temp.request_incomplete(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_typeof(r) = 'object'
    AND (NOT (r ? 'absorbedUpToSeq' AND r ? 'tools' AND r ? 'params')
      OR (r ? 'media' AND NOT r ? 'mediaBudgetBytes'))
$fn$;

-- Whether the request `r` left its tools out without the flag (the omission decided below).
CREATE OR REPLACE FUNCTION pg_temp.unflagged_empty(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_typeof(r -> 'tools') = 'array' AND jsonb_array_length(r -> 'tools') = 0
    AND NOT r ? 'catalog' AND NOT r ? 'toolsOmitted'
$fn$;

UPDATE conversation_events AS m
SET payload = jsonb_set(m.payload, '{request,toolsOmitted}', 'true'::jsonb)
WHERE m.type = 'model_call' AND pg_temp.unflagged_empty(m.payload -> 'request')
  AND EXISTS (SELECT 1 FROM conversation_events r
    WHERE r.conversation_id = m.conversation_id AND r.run_id IS NOT DISTINCT FROM m.run_id
      AND r.type = 'reminder' AND r.payload -> 'step' = m.payload -> 'step'
      AND r.payload ->> 'text' = 'Tools are unavailable for this model. Answer without calling tools.');

UPDATE conversation_events
SET payload = jsonb_set(payload, '{request}',
  pg_temp.with_request_fields(payload -> 'request', seq))
WHERE type = 'model_call' AND pg_temp.request_incomplete(payload -> 'request');

UPDATE eval_cases AS c
SET snapshot = jsonb_set(c.snapshot, '{events}', (
  SELECT jsonb_agg(CASE
      WHEN e ->> 'type' = 'model_call' AND pg_temp.request_incomplete(e -> 'payload' -> 'request')
      THEN jsonb_set(e, '{payload,request}',
        pg_temp.with_request_fields(e -> 'payload' -> 'request', (e ->> 'seq')::bigint))
      ELSE e END ORDER BY ord)
  FROM jsonb_array_elements(c.snapshot -> 'events') WITH ORDINALITY AS t(e, ord)))
WHERE jsonb_typeof(c.snapshot -> 'events') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot -> 'events') AS t(e)
    WHERE e ->> 'type' = 'model_call' AND pg_temp.request_incomplete(e -> 'payload' -> 'request'));

-- The same flag on the snapshot's calls, from the snapshot's own reminders: whether the call `e`
-- of the snapshot events `evs` qualifies.
CREATE OR REPLACE FUNCTION pg_temp.snapshot_omitted(e jsonb, evs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT e ->> 'type' = 'model_call' AND pg_temp.unflagged_empty(e -> 'payload' -> 'request')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(evs) AS u(r)
      WHERE r ->> 'type' = 'reminder' AND r -> 'runId' = e -> 'runId'
        AND r -> 'payload' -> 'step' = e -> 'payload' -> 'step'
        AND r -> 'payload' ->> 'text' =
          'Tools are unavailable for this model. Answer without calling tools.')
$fn$;

UPDATE eval_cases AS c
SET snapshot = jsonb_set(c.snapshot, '{events}', (
  SELECT jsonb_agg(CASE
      WHEN pg_temp.snapshot_omitted(e, c.snapshot -> 'events')
      THEN jsonb_set(e, '{payload,request,toolsOmitted}', 'true'::jsonb)
      ELSE e END ORDER BY ord)
  FROM jsonb_array_elements(c.snapshot -> 'events') WITH ORDINALITY AS t(e, ord)))
WHERE jsonb_typeof(c.snapshot -> 'events') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot -> 'events') AS t(e)
    WHERE pg_temp.snapshot_omitted(e, c.snapshot -> 'events'));

DROP FUNCTION IF EXISTS pg_temp.snapshot_omitted(jsonb, jsonb);
DROP FUNCTION IF EXISTS pg_temp.unflagged_empty(jsonb);
DROP FUNCTION IF EXISTS pg_temp.request_incomplete(jsonb);
DROP FUNCTION IF EXISTS pg_temp.with_request_fields(jsonb, bigint);
