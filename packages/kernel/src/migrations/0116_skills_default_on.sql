-- Skills are on by default and pinning is gone (spec 2026-11-12-skills-default-on-design.md §4,
-- §5): an agent stores only what it turns off (`disabledSkills`), not selected (`skills.orgSkills`)
-- or pinned (`skills.pinned`) skills. Every stored agent version, older ones included (a rollback
-- reads the same shape), becomes "nothing turned off"; `skills` stays only while it still holds
-- something (`writePolicy`). Idempotent: rows already rewritten match neither statement.
UPDATE agent_versions
SET definition = CASE
    WHEN ((definition -> 'skills') - 'orgSkills' - 'pinned') = '{}'::jsonb
      THEN definition - 'skills'
    ELSE jsonb_set(definition, '{skills}', (definition -> 'skills') - 'orgSkills' - 'pinned')
  END
WHERE jsonb_typeof(definition -> 'skills') = 'object'
  AND ((definition -> 'skills') ? 'orgSkills' OR (definition -> 'skills') ? 'pinned');

UPDATE agent_versions
SET definition = definition || jsonb_build_object('disabledSkills', '[]'::jsonb)
WHERE NOT definition ? 'disabledSkills';

-- Org-made agent templates (saved from an agent by an org admin: no plugin, no catalog item) lose
-- `selectedSkills`: with skills on by default there is nothing to select. Templates from plugin
-- packages keep what the package wrote (the kernel's template reader drops the field).
UPDATE agent_template_versions AS v
SET definition = v.definition - 'selectedSkills'
FROM agent_templates AS t
WHERE t.id = v.template_id
  AND t.plugin_name IS NULL
  AND t.catalog_item_id IS NULL
  AND v.definition ? 'selectedSkills';

UPDATE platform_agent_template_versions AS v
SET definition = v.definition - 'selectedSkills'
FROM platform_agent_templates AS t
WHERE t.id = v.template_id
  AND t.plugin_name IS NULL
  AND t.catalog_item_id IS NULL
  AND v.object_prefix IS NULL
  AND v.definition ? 'selectedSkills';
