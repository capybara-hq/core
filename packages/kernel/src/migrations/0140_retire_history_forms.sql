-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling), second pass: the
-- kernel stops reading the history-only forms of agent definitions and templates, so the stored
-- rows and logged events that may still hold one are rewritten once, here, to what the readers made
-- of them. Idempotent: a second run changes nothing.
--
-- 1. An agent definition from before tools and skills were on by default (an enabled `tools` list;
--    `skills.orgSkills` / `skills.pinned`) read as nothing turned off: the fields go (`skills`
--    with them when nothing else is left in it). Migrations 0092 and 0116 rewrote agent versions;
--    this covers them again plus the definitions frozen into `subagent_started` events and eval
--    case snapshots.
-- 2. A follow-up's narrowing (`user_message.dispatch.narrowed`) from before then carried no
--    `disabledTools` / `disabledSkills` (or `skills` instead) and narrowed nothing of that kind:
--    each missing list becomes the frozen definition's (the child's `subagent_started`), and
--    `skills` goes.
-- 3. Agent template versions lose `selectedSkills` (the reader dropped it; 0116 cleaned only the
--    org-made ones, plugin packages no longer write it).
--
-- Cost: the WHERE clauses are JSON predicates no index serves, so each UPDATE scans its whole table
-- once (`conversation_events` filtered by type, every `eval_cases` snapshot unpacked); the
-- narrowing step adds one primary-key lookup per old follow-up. Fine at release-candidate size, as
-- earlier event rewrites (0105) assumed; a deployment with a large log runs it in a quiet window.

-- `d` without the history-only fields of an agent definition.
CREATE OR REPLACE FUNCTION pg_temp.current_definition(d jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(d) IS DISTINCT FROM 'object' THEN d
    WHEN jsonb_typeof(d -> 'skills') = 'object'
      AND ((d -> 'skills') ? 'orgSkills' OR (d -> 'skills') ? 'pinned') THEN
      CASE
        WHEN ((d -> 'skills') - 'orgSkills' - 'pinned') = '{}'::jsonb THEN d - 'tools' - 'skills'
        ELSE jsonb_set(d - 'tools', '{skills}', (d -> 'skills') - 'orgSkills' - 'pinned')
      END
    ELSE d - 'tools'
  END
$fn$;

-- A follow-up narrowing `n` with both lists, filled from the frozen definition `frozen`.
CREATE OR REPLACE FUNCTION pg_temp.current_narrowing(n jsonb, frozen jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (n - 'skills') || jsonb_build_object(
    'disabledTools', CASE
      WHEN jsonb_typeof(n -> 'disabledTools') = 'array' THEN n -> 'disabledTools'
      WHEN jsonb_typeof(frozen -> 'disabledTools') = 'array' THEN frozen -> 'disabledTools'
      ELSE '[]'::jsonb END,
    'disabledSkills', CASE
      WHEN jsonb_typeof(n -> 'disabledSkills') = 'array' THEN n -> 'disabledSkills'
      WHEN jsonb_typeof(frozen -> 'disabledSkills') = 'array' THEN frozen -> 'disabledSkills'
      ELSE '[]'::jsonb END)
$fn$;

-- Does narrowing `n` still need rewriting?
CREATE OR REPLACE FUNCTION pg_temp.old_narrowing(n jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_typeof(n) = 'object' AND (
    n ? 'skills'
    OR jsonb_typeof(n -> 'disabledTools') IS DISTINCT FROM 'array'
    OR jsonb_typeof(n -> 'disabledSkills') IS DISTINCT FROM 'array')
$fn$;

-- Does definition `d` still hold a history-only field?
CREATE OR REPLACE FUNCTION pg_temp.old_definition(d jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_typeof(d) = 'object' AND (
    d ? 'tools'
    OR (jsonb_typeof(d -> 'skills') = 'object'
      AND ((d -> 'skills') ? 'orgSkills' OR (d -> 'skills') ? 'pinned')))
$fn$;

-- One logged event (a snapshot element or a row's payload wrapped as `{type, payload}`) in the
-- current form; `frozen` is its conversation's `subagent_started` definition (or NULL).
CREATE OR REPLACE FUNCTION pg_temp.current_event(e jsonb, frozen jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN e ->> 'type' = 'subagent_started' AND pg_temp.old_definition(e -> 'payload' -> 'definition')
      THEN jsonb_set(e, '{payload,definition}',
        pg_temp.current_definition(e -> 'payload' -> 'definition'))
    WHEN e ->> 'type' = 'user_message'
      AND pg_temp.old_narrowing(e -> 'payload' -> 'dispatch' -> 'narrowed')
      THEN jsonb_set(e, '{payload,dispatch,narrowed}',
        pg_temp.current_narrowing(e -> 'payload' -> 'dispatch' -> 'narrowed', frozen))
    ELSE e
  END
$fn$;

-- 1. agent versions
UPDATE agent_versions
SET definition = pg_temp.current_definition(definition)
WHERE pg_temp.old_definition(definition);

-- 1. frozen definitions in the log
UPDATE conversation_events
SET payload = jsonb_set(payload, '{definition}', pg_temp.current_definition(payload -> 'definition'))
WHERE type = 'subagent_started' AND pg_temp.old_definition(payload -> 'definition');

-- 2. follow-up narrowings in the log (after 1, so the frozen definition read is current)
UPDATE conversation_events AS m
SET payload = jsonb_set(m.payload, '{dispatch,narrowed}', pg_temp.current_narrowing(
  m.payload -> 'dispatch' -> 'narrowed',
  (SELECT s.payload -> 'definition' FROM conversation_events s
   WHERE s.conversation_id = m.conversation_id AND s.type = 'subagent_started'
   ORDER BY s.seq LIMIT 1)))
WHERE m.type = 'user_message' AND pg_temp.old_narrowing(m.payload -> 'dispatch' -> 'narrowed');

-- 1 and 2 in eval case snapshots: the versions' definitions, the child's definition and the events
UPDATE eval_cases AS c
SET snapshot = jsonb_set(jsonb_set(
    CASE WHEN jsonb_typeof(c.snapshot -> 'subagent') = 'object'
      THEN jsonb_set(c.snapshot, '{subagent,definition}',
        pg_temp.current_definition(c.snapshot -> 'subagent' -> 'definition'))
      ELSE c.snapshot END,
    '{definitions}', coalesce((
      SELECT jsonb_object_agg(k, pg_temp.current_definition(v))
      FROM jsonb_each(CASE WHEN jsonb_typeof(c.snapshot -> 'definitions') = 'object'
        THEN c.snapshot -> 'definitions' ELSE '{}'::jsonb END) AS d(k, v)), '{}'::jsonb)),
    '{events}', coalesce((
      SELECT jsonb_agg(pg_temp.current_event(e, (
        SELECT pg_temp.current_definition(f -> 'payload' -> 'definition')
        FROM jsonb_array_elements(c.snapshot -> 'events') AS s(f)
        WHERE f ->> 'type' = 'subagent_started' LIMIT 1)) ORDER BY ord)
      FROM jsonb_array_elements(c.snapshot -> 'events') WITH ORDINALITY AS t(e, ord)), '[]'::jsonb))
WHERE jsonb_typeof(c.snapshot -> 'events') = 'array'
  AND (
    pg_temp.old_definition(c.snapshot -> 'subagent' -> 'definition')
    OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(c.snapshot -> 'definitions') = 'object'
        THEN c.snapshot -> 'definitions' ELSE '{}'::jsonb END) AS d(k, v)
      WHERE pg_temp.old_definition(v))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(c.snapshot -> 'events') AS t(e)
      WHERE (e ->> 'type' = 'subagent_started'
          AND pg_temp.old_definition(e -> 'payload' -> 'definition'))
        OR (e ->> 'type' = 'user_message'
          AND pg_temp.old_narrowing(e -> 'payload' -> 'dispatch' -> 'narrowed'))));

-- 3. template versions
UPDATE agent_template_versions
SET definition = definition - 'selectedSkills'
WHERE definition ? 'selectedSkills';

UPDATE platform_agent_template_versions
SET definition = definition - 'selectedSkills'
WHERE definition ? 'selectedSkills';

DROP FUNCTION IF EXISTS pg_temp.current_event(jsonb, jsonb);
DROP FUNCTION IF EXISTS pg_temp.old_definition(jsonb);
DROP FUNCTION IF EXISTS pg_temp.old_narrowing(jsonb);
DROP FUNCTION IF EXISTS pg_temp.current_narrowing(jsonb, jsonb);
DROP FUNCTION IF EXISTS pg_temp.current_definition(jsonb);
