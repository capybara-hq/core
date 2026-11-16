-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): the kernel stops
-- reading release-candidate forms, so the stored rows that may still hold one are rewritten once,
-- here, and what existed only for those readers goes. Idempotent: a second run changes nothing.
--
-- 1. Release-candidate tool keys (tool naming spec §8) in stored agent definitions and agent
--    templates, which the kernel used to read as current keys on every load: an old builtin name
--    becomes its new name; an rc `<x>__<tool>` key becomes `mcp__<x>__<tool>` when `x` is only a
--    live connector slug of the row's org, `plugin__<x>__<tool>` when it is only an extension name
--    of the deployment (extension_installs, extension_name_owners), and both when it is both (a
--    deny / ask policy and a deny list keep the restriction on both; an allowlist keeps the old key,
--    which names no tool). A key of the removed builtin (`skill_write`, `SkillWrite`) is dropped.
--    Keys in the current format are never touched.
-- 2. Grants that still hold an rc key migration 0063 could not map name no tool: deleted, with the
--    partial indexes that only the startup notice about them read.
-- 3. Connector audit actions written before the D17 rename (`app.created` …) take their current
--    names; nothing else is inferred from the `app.` prefix (app bundles are unrelated).

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

-- An agent definition in current keys: its own policies and its inline sub-agent templates.
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
UPDATE agent_versions v
SET definition = pg_temp.rc_definition(v.definition, a.org_id)
FROM agents a
WHERE a.id = v.agent_id
  AND pg_temp.rc_definition(v.definition, a.org_id) <> v.definition;

-- capybara:allow-destructive rewrites rc tool keys in place; no kernel version reads them any more
UPDATE agent_template_versions v
SET definition = pg_temp.rc_template(v.definition, t.org_id)
FROM agent_templates t
WHERE t.id = v.template_id
  AND pg_temp.rc_template(v.definition, t.org_id) <> v.definition;

-- capybara:allow-destructive rewrites rc tool keys in place; no kernel version reads them any more
UPDATE platform_agent_template_versions v
SET definition = pg_temp.rc_template(v.definition, NULL)
WHERE pg_temp.rc_template(v.definition, NULL) <> v.definition;

DROP FUNCTION IF EXISTS pg_temp.rc_definition(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_template(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_policies(jsonb, text);
DROP FUNCTION IF EXISTS pg_temp.rc_key_list(jsonb, text, boolean);
DROP FUNCTION IF EXISTS pg_temp.rc_tool_keys(text, text);

-- capybara:allow-destructive grants on an rc key 0063 could not map name no tool and never apply
DELETE FROM tool_grants
WHERE tool_key = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit',
    'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write', 'ask_user',
    'read_tool_output', 'tool_search', 'agent']::text[])
  OR (tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND tool_key !~ '^(mcp|plugin)__');

-- capybara:allow-destructive grants on an rc key 0063 could not map name no tool and never apply
DELETE FROM conversation_tool_grants
WHERE tool_key = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit',
    'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write', 'ask_user',
    'read_tool_output', 'tool_search', 'agent']::text[])
  OR (tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND tool_key !~ '^(mcp|plugin)__');

DROP INDEX IF EXISTS tool_grants_legacy_key_idx;
DROP INDEX IF EXISTS conversation_tool_grants_legacy_key_idx;
DROP INDEX IF EXISTS approvals_legacy_key_idx;
DROP INDEX IF EXISTS questions_legacy_key_idx;

-- capybara:allow-destructive renames audit actions in place; no kernel version reads the old names
UPDATE audit_events e
SET action = m.new_action
FROM (VALUES
  ('app.created', 'connector.created'),
  ('app.updated', 'connector.updated'),
  ('app.deleted', 'connector.deleted'),
  ('app.tools_refreshed', 'connector.tools_refreshed'),
  ('app.tools_drifted', 'connector.tools_drifted'),
  ('app.tool_reviewed', 'connector.tool_reviewed'),
  ('app.credential.set', 'connector.credential.set'),
  ('app.credential.cleared', 'connector.credential.cleared')
) AS m(old_action, new_action)
WHERE e.action = m.old_action;
