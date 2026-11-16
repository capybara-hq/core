-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): `model_call.request`
-- requires what the runtime always records, so `model_call` rows logged before a field existed
-- (development databases from before rc.0) get it once, here (the log and the events in eval case
-- snapshots), with the value the old readers assumed. Idempotent: a second run matches nothing.
--
-- - `absorbedUpToSeq`: the call's own seq (the old fallback: it took in everything before it).
-- - `tools`: [] with `toolsOmitted: true`: such a request carried no tools, and the tool-change
--   notice skipped a call without recorded tools, as it skips an omitted set.
-- - `params`: {} (requests carried no parameters before they were recorded).
-- - `mediaBudgetBytes`, on a call that recorded `media` without it: the default
--   `attachments.requestMediaBytes` (20 MiB) of the time, an approximation (only step replay reads
--   it, and only for those calls).
-- - `maxOutputTokens` is not filled: every writer set it from the first `model_call` on.
--
-- Cost: one pass over the `model_call` rows of `conversation_events` (and over `eval_cases`), done
-- once; release-candidate-sized tables, as earlier event rewrites (0105, 0142) assumed.

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

DROP FUNCTION IF EXISTS pg_temp.request_incomplete(jsonb);
DROP FUNCTION IF EXISTS pg_temp.with_request_fields(jsonb, bigint);
