-- Tools are on by default (spec 2026-11-08-tools-default-on-design.md §3): an agent stores only
-- what it turns off (`disabledTools`), not an enabled list (`tools`). Every stored agent version,
-- older ones included (a rollback reads the same shape), becomes "nothing turned off". Idempotent:
-- a definition without `tools` is left alone, one without `disabledTools` gets the empty list.
UPDATE agent_versions
SET definition = (definition - 'tools') || jsonb_build_object('disabledTools', '[]'::jsonb)
WHERE definition ? 'tools' OR NOT definition ? 'disabledTools';

-- Org-made agent templates (saved from an agent by an org admin: no plugin, no catalog item)
-- lose their `tools` allowlist, so they turn nothing off either. Templates from plugin packages
-- keep what the package wrote.
UPDATE agent_template_versions AS v
SET definition = v.definition - 'tools'
FROM agent_templates AS t
WHERE t.id = v.template_id
  AND t.plugin_name IS NULL
  AND t.catalog_item_id IS NULL
  AND v.definition ? 'tools';

UPDATE platform_agent_template_versions AS v
SET definition = v.definition - 'tools'
FROM platform_agent_templates AS t
WHERE t.id = v.template_id
  AND t.plugin_name IS NULL
  AND t.catalog_item_id IS NULL
  AND v.object_prefix IS NULL
  AND v.definition ? 'tools';
