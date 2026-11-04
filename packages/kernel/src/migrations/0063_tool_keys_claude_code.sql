-- Tool naming (spec docs/superpowers/specs/2026-10-29-tool-naming-claude-code-design.md §8.2):
-- the release candidates' tool keys in mutable state become the current keys. Builtins by the
-- frozen map of packages/kernel/src/tools/legacy-keys.ts (LEGACY_BUILTINS); an rc `<x>__<tool>`
-- key becomes `mcp__<x>__<tool>` when `x` is a connector of the row's org (or the row records its
-- connector) and `plugin__<x>__<tool>` when `x` is an extension of the deployment
-- (extension_installs, or extension_name_owners for config-declared ones); when both or neither,
-- the row stays and the kernel's startup notice `tools.legacy_key_unmapped` counts it.
-- Keys in the current format never match. A grant whose new key already exists for the same
-- owner is left as it is (the primary key). Decided approvals and answered questions are
-- history and stay. Logs and recordings are never rewritten (§8). Idempotent: a second run
-- matches nothing it could change.

-- capybara:allow-destructive rewrites rc tool keys in place (the old keys no longer name a tool; the kernel reads only the new ones)
UPDATE tool_grants g
SET tool_key = m.new_key
FROM (VALUES
  ('sandbox_bash', 'Bash'), ('sandbox_read', 'Read'), ('sandbox_write', 'Write'),
  ('sandbox_edit', 'Edit'), ('sandbox_glob', 'Glob'), ('sandbox_grep', 'Grep'),
  ('sandbox_deliver', 'Deliver'), ('skill_load', 'Skill'), ('skill_write', 'SkillWrite'),
  ('ask_user', 'AskUserQuestion'), ('read_tool_output', 'ReadToolOutput'),
  ('tool_search', 'ToolSearch'), ('agent', 'Agent')
) AS m(old_key, new_key)
WHERE g.tool_key = m.old_key
  AND NOT EXISTS (
    SELECT 1 FROM tool_grants x
    WHERE x.org_id = g.org_id AND x.account_id = g.account_id AND x.agent_id = g.agent_id
      AND x.tool_key = m.new_key
  );

-- capybara:allow-destructive rewrites rc tool keys in place (the old keys no longer name a tool; the kernel reads only the new ones)
UPDATE tool_grants g
SET tool_key = CASE
  WHEN g.connector_id IS NOT NULL OR (
    EXISTS (SELECT 1 FROM connectors c
            WHERE c.org_id = g.org_id AND c.deleted_at IS NULL
              AND c.slug = split_part(g.tool_key, '__', 1))
    AND split_part(g.tool_key, '__', 1) NOT IN (
      SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
  ) THEN 'mcp__' || g.tool_key
  ELSE 'plugin__' || g.tool_key
END
WHERE g.tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND g.tool_key !~ '^(mcp|plugin)__'
  AND (
    g.connector_id IS NOT NULL
    OR (
      EXISTS (SELECT 1 FROM connectors c
              WHERE c.org_id = g.org_id AND c.deleted_at IS NULL
                AND c.slug = split_part(g.tool_key, '__', 1))
    ) <> (
      split_part(g.tool_key, '__', 1) IN (
        SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM tool_grants x
    WHERE x.org_id = g.org_id AND x.account_id = g.account_id AND x.agent_id = g.agent_id
      AND x.tool_key IN ('mcp__' || g.tool_key, 'plugin__' || g.tool_key)
  );

-- capybara:allow-destructive rewrites rc tool keys in place (the old keys no longer name a tool; the kernel reads only the new ones)
UPDATE conversation_tool_grants g
SET tool_key = m.new_key
FROM (VALUES
  ('sandbox_bash', 'Bash'), ('sandbox_read', 'Read'), ('sandbox_write', 'Write'),
  ('sandbox_edit', 'Edit'), ('sandbox_glob', 'Glob'), ('sandbox_grep', 'Grep'),
  ('sandbox_deliver', 'Deliver'), ('skill_load', 'Skill'), ('skill_write', 'SkillWrite'),
  ('ask_user', 'AskUserQuestion'), ('read_tool_output', 'ReadToolOutput'),
  ('tool_search', 'ToolSearch'), ('agent', 'Agent')
) AS m(old_key, new_key)
WHERE g.tool_key = m.old_key
  AND NOT EXISTS (
    SELECT 1 FROM conversation_tool_grants x
    WHERE x.conversation_id = g.conversation_id AND x.tool_key = m.new_key
  );

-- capybara:allow-destructive rewrites rc tool keys in place (the old keys no longer name a tool; the kernel reads only the new ones)
UPDATE conversation_tool_grants g
SET tool_key = CASE
  WHEN g.connector_id IS NOT NULL OR (
    EXISTS (SELECT 1 FROM connectors c
            WHERE c.org_id = v.org_id AND c.deleted_at IS NULL
              AND c.slug = split_part(g.tool_key, '__', 1))
    AND split_part(g.tool_key, '__', 1) NOT IN (
      SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
  ) THEN 'mcp__' || g.tool_key
  ELSE 'plugin__' || g.tool_key
END
FROM conversations v
WHERE v.id = g.conversation_id
  AND g.tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND g.tool_key !~ '^(mcp|plugin)__'
  AND (
    g.connector_id IS NOT NULL
    OR (
      EXISTS (SELECT 1 FROM connectors c
              WHERE c.org_id = v.org_id AND c.deleted_at IS NULL
                AND c.slug = split_part(g.tool_key, '__', 1))
    ) <> (
      split_part(g.tool_key, '__', 1) IN (
        SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM conversation_tool_grants x
    WHERE x.conversation_id = g.conversation_id
      AND x.tool_key IN ('mcp__' || g.tool_key, 'plugin__' || g.tool_key)
  );

-- capybara:allow-destructive rewrites rc tool keys of pending approvals in place (resumed by run and call id, never by key)
UPDATE approvals a
SET tool_key = m.new_key
FROM (VALUES
  ('sandbox_bash', 'Bash'), ('sandbox_read', 'Read'), ('sandbox_write', 'Write'),
  ('sandbox_edit', 'Edit'), ('sandbox_glob', 'Glob'), ('sandbox_grep', 'Grep'),
  ('sandbox_deliver', 'Deliver'), ('skill_load', 'Skill'), ('skill_write', 'SkillWrite'),
  ('ask_user', 'AskUserQuestion'), ('read_tool_output', 'ReadToolOutput'),
  ('tool_search', 'ToolSearch'), ('agent', 'Agent')
) AS m(old_key, new_key)
WHERE a.status = 'pending' AND a.tool_key = m.old_key;

-- capybara:allow-destructive rewrites rc tool keys of pending approvals in place (resumed by run and call id, never by key)
UPDATE approvals a
SET tool_key = CASE
  WHEN a.connector_id IS NOT NULL OR (
    EXISTS (SELECT 1 FROM connectors c
            WHERE c.org_id = a.org_id AND c.deleted_at IS NULL
              AND c.slug = split_part(a.tool_key, '__', 1))
    AND split_part(a.tool_key, '__', 1) NOT IN (
      SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
  ) THEN 'mcp__' || a.tool_key
  ELSE 'plugin__' || a.tool_key
END
WHERE a.status = 'pending'
  AND a.tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND a.tool_key !~ '^(mcp|plugin)__'
  AND (
    a.connector_id IS NOT NULL
    OR (
      EXISTS (SELECT 1 FROM connectors c
              WHERE c.org_id = a.org_id AND c.deleted_at IS NULL
                AND c.slug = split_part(a.tool_key, '__', 1))
    ) <> (
      split_part(a.tool_key, '__', 1) IN (
        SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
    )
  );

-- capybara:allow-destructive rewrites rc tool keys of pending questions in place (resumed by run and call id, never by key)
UPDATE questions q
SET spec = jsonb_set(q.spec, '{toolKey}', to_jsonb(m.new_key))
FROM (VALUES
  ('sandbox_bash', 'Bash'), ('sandbox_read', 'Read'), ('sandbox_write', 'Write'),
  ('sandbox_edit', 'Edit'), ('sandbox_glob', 'Glob'), ('sandbox_grep', 'Grep'),
  ('sandbox_deliver', 'Deliver'), ('skill_load', 'Skill'), ('skill_write', 'SkillWrite'),
  ('ask_user', 'AskUserQuestion'), ('read_tool_output', 'ReadToolOutput'),
  ('tool_search', 'ToolSearch'), ('agent', 'Agent')
) AS m(old_key, new_key)
WHERE q.status = 'pending' AND q.spec->>'toolKey' = m.old_key;

-- capybara:allow-destructive rewrites rc tool keys of pending questions in place (resumed by run and call id, never by key)
UPDATE questions q
SET spec = jsonb_set(
  q.spec,
  '{toolKey}',
  to_jsonb(CASE
    WHEN EXISTS (SELECT 1 FROM connectors c
                 WHERE c.org_id = q.org_id AND c.deleted_at IS NULL
                   AND c.slug = split_part(q.spec->>'toolKey', '__', 1))
    THEN 'mcp__' || (q.spec->>'toolKey')
    ELSE 'plugin__' || (q.spec->>'toolKey')
  END)
)
WHERE q.status = 'pending'
  AND q.spec->>'toolKey' ~ '^[a-z0-9][a-z0-9_-]*__.' AND q.spec->>'toolKey' !~ '^(mcp|plugin)__'
  AND (
    EXISTS (SELECT 1 FROM connectors c
            WHERE c.org_id = q.org_id AND c.deleted_at IS NULL
              AND c.slug = split_part(q.spec->>'toolKey', '__', 1))
  ) <> (
    split_part(q.spec->>'toolKey', '__', 1) IN (
      SELECT name FROM extension_installs UNION SELECT name FROM extension_name_owners)
  );

-- What the startup notice counts (rows the statements above could not map), each over a partial
-- index holding only such rows, so the count at every start reads nearly empty indexes. The
-- predicate is the one of countLegacyToolKeys (packages/kernel/src/tools/legacy-data.ts).
CREATE INDEX IF NOT EXISTS tool_grants_legacy_key_idx ON tool_grants (org_id)
  WHERE (tool_key = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit',
    'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write', 'ask_user',
    'read_tool_output', 'tool_search', 'agent']::text[])
    OR (tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND tool_key !~ '^(mcp|plugin)__'));
CREATE INDEX IF NOT EXISTS conversation_tool_grants_legacy_key_idx
  ON conversation_tool_grants (conversation_id)
  WHERE (tool_key = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit',
    'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write', 'ask_user',
    'read_tool_output', 'tool_search', 'agent']::text[])
    OR (tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND tool_key !~ '^(mcp|plugin)__'));
CREATE INDEX IF NOT EXISTS approvals_legacy_key_idx ON approvals (org_id)
  WHERE status = 'pending'
    AND (tool_key = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write', 'sandbox_edit',
    'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write', 'ask_user',
    'read_tool_output', 'tool_search', 'agent']::text[])
    OR (tool_key ~ '^[a-z0-9][a-z0-9_-]*__.' AND tool_key !~ '^(mcp|plugin)__'));
CREATE INDEX IF NOT EXISTS questions_legacy_key_idx ON questions (org_id)
  WHERE status = 'pending'
    AND ((spec->>'toolKey') = ANY (ARRAY['sandbox_bash', 'sandbox_read', 'sandbox_write',
    'sandbox_edit', 'sandbox_glob', 'sandbox_grep', 'sandbox_deliver', 'skill_load', 'skill_write',
    'ask_user', 'read_tool_output', 'tool_search', 'agent']::text[])
    OR ((spec->>'toolKey') ~ '^[a-z0-9][a-z0-9_-]*__.' AND (spec->>'toolKey') !~ '^(mcp|plugin)__'));

-- Read before Write / Edit (spec §4.5): EventLog.latestFileState reads the latest tool_result of
-- a conversation whose view names a file, on every Write and Edit. Without this index it scans
-- the conversation's events backwards through the primary key, filtering each payload (EXPLAIN
-- on a 20 000-event conversation: every row removed by the filter for a path never read); with
-- it, one index probe. Partial: only tool_result rows. Built without CONCURRENTLY (a migration
-- runs in one transaction), which locks conversation_events against writes while it builds: this
-- assumes release-candidate-sized event tables, as the event indexes of 0025 and 0040 did. A
-- deployment with a large table builds it CONCURRENTLY by hand before upgrading; IF NOT EXISTS
-- then skips it here.
CREATE INDEX IF NOT EXISTS conversation_events_file_state_idx
  ON conversation_events (conversation_id, ((payload->'view'->'file'->>'path')), seq DESC)
  WHERE type = 'tool_result';
