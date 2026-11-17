-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): migration 0139
-- rewrote release-candidate tool keys in agent versions and templates, but a sub-agent's definition
-- frozen at dispatch is a copy the kernel reads again on every follow-up and in eval replays. Those
-- copies get the same rewrite once, here, with the org of the conversation (or eval case) holding
-- them:
-- - the log: `subagent_started.payload.definition` in `conversation_events`;
-- - eval case snapshots: `definitions` (each version's definition), `subagent.definition`, and the
--   `subagent_started` events among `events`.
-- The functions are 0139's, copied (pg_temp functions live only for this file's session). Keys in
-- the current format are never touched. Idempotent: a second run changes nothing.
--
-- Cost: one pass over the `subagent_started` rows of `conversation_events` and over `eval_cases`,
-- done once; release-candidate-sized tables, as earlier event rewrites (0105, 0142) assumed.

-- The current key(s) of `k` in org `org` (NULL for a platform template: no connector of its own).
CREATE OR REPLACE FUNCTION pg_temp.rc_tool_keys(k text, org text) RETURNS text[]
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN k IN ('skill_write', 'SkillWrite') THEN ARRAY[]::text[]
    WHEN k IN ('sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit', 'sandbox_glob',
               'sandbox_grep', 'sandbox_deliver', 'skill_load', 'ask_user', 'read_tool_output',
               'tool_search', 'agent') THEN ARRAY[CASE k
      WHEN 'sandbox_bash' THEN 'Bash' WHEN 'sandbox_read' THEN 'Read'
      WHEN 'sandbox_write' THEN 'Write' WHEN 'sandbox_edit' THEN 'Edit'
      WHEN 'sandbox_glob' THEN 'Glob' WHEN 'sandbox_grep' THEN 'Grep'
      WHEN 'sandbox_deliver' THEN 'Deliver' WHEN 'skill_load' THEN 'Skill'
      WHEN 'ask_user' THEN 'AskUserQuestion' WHEN 'read_tool_output' THEN 'ReadToolOutput'
      WHEN 'tool_search' THEN 'ToolSearch' ELSE 'Agent' END]
    WHEN k ~ '^[a-z0-9][a-z0-9_-]*__.' AND k !~ '^(mcp|plugin)__' THEN (
      SELECT CASE
        WHEN s.c AND NOT s.e THEN ARRAY['mcp__' || k]
        WHEN s.e AND NOT s.c THEN ARRAY['plugin__' || k]
        WHEN s.c AND s.e THEN ARRAY['mcp__' || k, 'plugin__' || k]
        ELSE ARRAY[k]
      END
      FROM (
        SELECT
          EXISTS (SELECT 1 FROM connectors c
                  WHERE c.org_id = org AND c.deleted_at IS NULL
                    AND c.slug = split_part(k, '__', 1)) AS c,
          split_part(k, '__', 1) IN (
            SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners) AS e
      ) s)
    ELSE ARRAY[k]
  END
$fn$;

-- A list of tool keys (a template's `tools` allowlist, `widen` false, or `disallowedTools`, `widen`
-- true) in current keys, in order, without repeats; other values as they are.
CREATE OR REPLACE FUNCTION pg_temp.rc_key_list(l jsonb, org text, widen boolean) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(l) IS DISTINCT FROM 'array' THEN l ELSE coalesce((
    SELECT jsonb_agg(d.v ORDER BY d.pos) FROM (
      SELECT DISTINCT ON (n.v) n.v, n.pos FROM (
        SELECT x.ord * 10 + 1 AS pos, x.e AS v
        FROM jsonb_array_elements(l) WITH ORDINALITY AS x(e, ord)
        WHERE jsonb_typeof(x.e) <> 'string'
        UNION ALL
        SELECT x.ord * 10 + u.i, to_jsonb(u.key)
        FROM jsonb_array_elements(l) WITH ORDINALITY AS x(e, ord)
        CROSS JOIN LATERAL (SELECT pg_temp.rc_tool_keys(x.e #>> '{}', org) AS ks) s
        CROSS JOIN LATERAL unnest(
          CASE WHEN widen OR cardinality(s.ks) <= 1 THEN s.ks ELSE ARRAY[x.e #>> '{}'] END
        ) WITH ORDINALITY AS u(key, i)
        WHERE jsonb_typeof(x.e) = 'string'
      ) n
      ORDER BY n.v, n.pos
    ) d), '[]'::jsonb) END
$fn$;

-- `toolPolicies` in current keys: keys that become one keep the stricter policy; a key with two
-- candidates keeps only an ask / deny, on both.
CREATE OR REPLACE FUNCTION pg_temp.rc_policies(p jsonb, org text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN p ELSE coalesce((
    SELECT jsonb_object_agg(t.key, t.v) FROM (
      SELECT DISTINCT ON (nk) nk AS key, e.value AS v
      FROM jsonb_each(p) AS e
      CROSS JOIN LATERAL (SELECT pg_temp.rc_tool_keys(e.key, org) AS ks) s
      CROSS JOIN LATERAL unnest(s.ks) AS nk
      WHERE cardinality(s.ks) = 1 OR e.value IN ('"ask"'::jsonb, '"deny"'::jsonb)
      ORDER BY nk,
        CASE e.value WHEN '"deny"'::jsonb THEN 0 WHEN '"ask"'::jsonb THEN 1 ELSE 2 END
    ) t), '{}'::jsonb) END
$fn$;

-- A template-shaped value (an agent template, an inline sub-agent, an agent definition's own
-- `toolPolicies`) in current keys.
CREATE OR REPLACE FUNCTION pg_temp.rc_template(t jsonb, org text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(t) IS DISTINCT FROM 'object' THEN t ELSE t
    || CASE WHEN t ? 'tools'
         THEN jsonb_build_object('tools', pg_temp.rc_key_list(t -> 'tools', org, false))
         ELSE '{}'::jsonb END
    || CASE WHEN t ? 'disallowedTools'
         THEN jsonb_build_object('disallowedTools',
           pg_temp.rc_key_list(t -> 'disallowedTools', org, true))
         ELSE '{}'::jsonb END
    || CASE WHEN t ? 'toolPolicies'
         THEN jsonb_build_object('toolPolicies', pg_temp.rc_policies(t -> 'toolPolicies', org))
         ELSE '{}'::jsonb END
  END
$fn$;

-- An agent definition or an agent template in current keys: its own keys and those of its inline
-- sub-agent templates.
CREATE OR REPLACE FUNCTION pg_temp.rc_definition(d jsonb, org text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT pg_temp.rc_template(d, org) || CASE
    WHEN jsonb_typeof(d -> 'subagents' -> 'inline') = 'array' THEN jsonb_build_object(
      'subagents',
      jsonb_set(d -> 'subagents', '{inline}', (
        SELECT coalesce(jsonb_agg(pg_temp.rc_template(x.e, org) ORDER BY x.ord), '[]'::jsonb)
        FROM jsonb_array_elements(d -> 'subagents' -> 'inline') WITH ORDINALITY AS x(e, ord))))
    ELSE '{}'::jsonb
  END
$fn$;

-- capybara:allow-destructive rewrites rc tool keys in place; no kernel version reads them any more
UPDATE conversation_events e
SET payload = jsonb_set(e.payload, '{definition}',
  pg_temp.rc_definition(e.payload -> 'definition', c.org_id))
FROM conversations c
WHERE c.id = e.conversation_id AND e.type = 'subagent_started'
  AND jsonb_typeof(e.payload -> 'definition') = 'object'
  AND pg_temp.rc_definition(e.payload -> 'definition', c.org_id) <> e.payload -> 'definition';

-- A case snapshot `s` of org `org` in current keys.
CREATE OR REPLACE FUNCTION pg_temp.rc_snapshot(s jsonb, org text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT s
    || CASE WHEN jsonb_typeof(s -> 'definitions') = 'object' THEN jsonb_build_object(
         'definitions', (
           SELECT coalesce(jsonb_object_agg(d.key, pg_temp.rc_definition(d.value, org)), '{}'::jsonb)
           FROM jsonb_each(s -> 'definitions') AS d))
       ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(s -> 'subagent' -> 'definition') = 'object' THEN jsonb_build_object(
         'subagent', jsonb_set(s -> 'subagent', '{definition}',
           pg_temp.rc_definition(s -> 'subagent' -> 'definition', org)))
       ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(s -> 'events') = 'array' THEN jsonb_build_object(
         'events', (
           SELECT coalesce(jsonb_agg(CASE
               WHEN x.e ->> 'type' = 'subagent_started'
                 AND jsonb_typeof(x.e -> 'payload' -> 'definition') = 'object'
               THEN jsonb_set(x.e, '{payload,definition}',
                 pg_temp.rc_definition(x.e -> 'payload' -> 'definition', org))
               ELSE x.e END ORDER BY x.ord), '[]'::jsonb)
           FROM jsonb_array_elements(s -> 'events') WITH ORDINALITY AS x(e, ord)))
       ELSE '{}'::jsonb END
$fn$;

-- capybara:allow-destructive rewrites rc tool keys in place; no kernel version reads them any more
UPDATE eval_cases
SET snapshot = pg_temp.rc_snapshot(snapshot, org_id)
WHERE jsonb_typeof(snapshot) = 'object' AND pg_temp.rc_snapshot(snapshot, org_id) <> snapshot;

DROP FUNCTION IF EXISTS pg_temp.rc_snapshot(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_definition(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_template(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_policies(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_key_list(jsonb, text, boolean);
DROP FUNCTION IF EXISTS pg_temp.rc_tool_keys(text, text);
