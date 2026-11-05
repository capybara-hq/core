-- Plugin scope follow-up to 0074 (spec 2026-11-05-plugin-component-management-design.md §6
-- "Migration of what exists"): 0074 listed and switched on only the org installs with status
-- `installed`. An install that was `installing` or `upgrading` when 0074 ran got no switch row,
-- which for an `optional` item means off, and no place on a `named` item's org list; the worker's
-- start-time scope resync would then uninstall it. Such installs get what 0074 gave installed ones:
-- the org on the named list and a switch row `enabled = true` (builtin / `all` items need none).
-- Expand-only and idempotent: inserts only, ON CONFLICT DO NOTHING (a row an org admin, 0074 or
-- 0077 wrote wins).
INSERT INTO catalog_item_scope_orgs (item_id, org_id)
  SELECT DISTINCT p.item_id, p.org_id FROM plugin_installs p
  JOIN catalog_items i ON i.id = p.item_id AND i.scope = 'named'
  WHERE p.status IN ('installing', 'upgrading')
  ON CONFLICT DO NOTHING;

INSERT INTO catalog_item_org_switches (item_id, org_id, enabled)
  SELECT DISTINCT p.item_id, p.org_id, true FROM plugin_installs p
  JOIN catalog_items i ON i.id = p.item_id AND i.scope <> 'all'
  WHERE p.status IN ('installing', 'upgrading')
  ON CONFLICT DO NOTHING;
