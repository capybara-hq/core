-- Plugin scope follow-up to 0074 (spec 2026-11-05-plugin-component-management-design.md §6
-- "Migration of what exists"): 0074 put the orgs granted a `needs_approval` item on its `named`
-- list, where a listed org without a switch row wants the plugin on. A grant only allowed an
-- install; an org that never installed it did not have it on. Such orgs get an explicit switch
-- row `enabled = false`, so the plugin stays off there until an org admin switches it on.
-- Expand-only and idempotent: inserts only, ON CONFLICT DO NOTHING (a switch row an org admin or
-- 0074 wrote wins).
INSERT INTO catalog_item_org_switches (item_id, org_id, enabled)
  SELECT s.item_id, s.org_id, false
  FROM catalog_item_scope_orgs s
  JOIN catalog_items i ON i.id = s.item_id AND i.policy = 'needs_approval'
  JOIN catalog_org_grants g ON g.item_id = s.item_id AND g.org_id = s.org_id
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_installs p
    WHERE p.item_id = s.item_id AND p.org_id = s.org_id
      AND p.status IN ('installing', 'installed', 'upgrading')
  )
  ON CONFLICT DO NOTHING;
