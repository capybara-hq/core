-- Plugin scope (phase 1, spec 2026-11-05-plugin-component-management-design.md §5): every catalog item
-- gets a scope (all / optional / named), a builtin flag, a disabled flag, an org list (named) and
-- per-org switches. Replaces the catalog policy, grants and requests. Expand-only: `policy`,
-- `catalog_org_grants` and `catalog_requests` stay (nothing reads them after this release).
-- The backfill runs once per database (the migrator records the file); the UPDATEs below only read
-- the old columns, and the inserts are ON CONFLICT DO NOTHING.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'optional';
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_scope_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_scope_check
  CHECK (scope IN ('all', 'optional', 'named'));
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS builtin boolean NOT NULL DEFAULT false;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS scope_version integer NOT NULL DEFAULT 0;

-- named scope: the orgs the item is offered to.
CREATE TABLE IF NOT EXISTS catalog_item_scope_orgs (
  item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, org_id)
);

-- Per-org on / off switch of an item's components.
CREATE TABLE IF NOT EXISTS catalog_item_org_switches (
  item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, org_id)
);

-- Backfill from policy / grants / installs.
UPDATE catalog_items SET disabled = true WHERE policy = 'disabled';
UPDATE catalog_items SET scope = 'named' WHERE policy = 'needs_approval';

-- Required bootstrap plugins are builtin and offered to every org.
UPDATE catalog_items SET scope = 'all', builtin = true
  WHERE id IN (SELECT catalog_item_id FROM extension_installs
               WHERE required AND catalog_item_id IS NOT NULL);

-- named: granted orgs and orgs that already installed it.
INSERT INTO catalog_item_scope_orgs (item_id, org_id)
  SELECT g.item_id, g.org_id FROM catalog_org_grants g
  JOIN catalog_items i ON i.id = g.item_id AND i.scope = 'named'
  ON CONFLICT DO NOTHING;
INSERT INTO catalog_item_scope_orgs (item_id, org_id)
  SELECT DISTINCT p.item_id, p.org_id FROM plugin_installs p
  JOIN catalog_items i ON i.id = p.item_id AND i.scope = 'named'
  WHERE p.status = 'installed'
  ON CONFLICT DO NOTHING;

-- An org that installed the item keeps it on (builtin / all items need no switch).
INSERT INTO catalog_item_org_switches (item_id, org_id, enabled)
  SELECT DISTINCT p.item_id, p.org_id, true FROM plugin_installs p
  JOIN catalog_items i ON i.id = p.item_id AND i.scope <> 'all'
  WHERE p.status = 'installed'
  ON CONFLICT DO NOTHING;

-- Requests are gone: pending ones are withdrawn ('cancelled', the status the old withdraw used).
UPDATE catalog_requests SET status = 'cancelled', note = 'superseded by scope', decided_at = now()
  WHERE status = 'pending';
