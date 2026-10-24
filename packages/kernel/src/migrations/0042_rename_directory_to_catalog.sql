-- Phase 0a terminology: catalog sources become marketplaces, then the enterprise directory becomes
-- the catalog (in that order: the catalog_* names are free only once the sources are renamed).
-- Columns directory_item_id / directory_version / catalog_source_id become catalog_item_id /
-- catalog_version / marketplace_id. Index, FK and PK names are not renamed (as in 0033). A catalog
-- item version's `source` value 'catalog' (imported from a catalog source) becomes 'marketplace'.
-- directory_exclusions belongs to directory sync (directory@1) and is not touched. No compatibility
-- views (nothing is released yet).

-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS catalog_sources RENAME TO marketplaces;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS catalog_entries RENAME TO marketplace_entries;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS directory_items RENAME TO catalog_items;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS directory_item_versions RENAME TO catalog_item_versions;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS directory_requests RENAME TO catalog_requests;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS directory_org_grants RENAME TO catalog_org_grants;

-- RENAME COLUMN has no IF EXISTS: check information_schema first, so a second run does nothing.
-- capybara:allow-destructive column rename; code is renamed in the same release (project not released, no compatibility layer)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('connectors', 'directory_item_id', 'catalog_item_id'),
      ('connectors', 'directory_version', 'catalog_version'),
      ('skills', 'directory_item_id', 'catalog_item_id'),
      ('skills', 'directory_version', 'catalog_version'),
      ('skill_versions', 'directory_item_id', 'catalog_item_id'),
      ('skill_versions', 'directory_version', 'catalog_version'),
      ('extension_installs', 'directory_item_id', 'catalog_item_id'),
      ('catalog_items', 'catalog_source_id', 'marketplace_id')
    ) AS c(t, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'capybara' AND table_name = r.t AND column_name = r.old_name
    ) THEN
      EXECUTE format('ALTER TABLE capybara.%I RENAME COLUMN %I TO %I', r.t, r.old_name, r.new_name);
    END IF;
  END LOOP;
END
$$;

-- source 'catalog' -> 'marketplace': drop the CHECK (under its 0035 name, or ours on a second run),
-- rewrite the rows, add it back. The whole file runs in one transaction, so this is repeatable.
ALTER TABLE catalog_item_versions DROP CONSTRAINT IF EXISTS directory_item_versions_source_check;
ALTER TABLE catalog_item_versions DROP CONSTRAINT IF EXISTS catalog_item_versions_source_check;
UPDATE catalog_item_versions SET source = 'marketplace' WHERE source = 'catalog';
ALTER TABLE catalog_item_versions ADD CONSTRAINT catalog_item_versions_source_check
  CHECK (source IN ('file', 'npm', 'marketplace'));

-- App bundles staged before this migration (rows live 24 hours) keep their source as JSON: kind
-- 'catalog' becomes 'marketplace' and the key catalogSourceId becomes marketplaceId, so confirming
-- one still writes a valid version source. Skipped when the table is gone (renamed by a later
-- migration), so a second run is harmless.
-- capybara:allow-destructive rewrites one JSON value of staged rows (24-hour TTL); the DO block only adds the table existence check
DO $$
BEGIN
  IF to_regclass('capybara.app_import_staging') IS NOT NULL THEN
    UPDATE capybara.app_import_staging
      SET source = (source - 'catalogSourceId')
        || jsonb_build_object(
          'kind',
          CASE WHEN source->>'kind' = 'catalog' THEN 'marketplace' ELSE source->>'kind' END
        )
        || CASE
          WHEN source ? 'catalogSourceId'
            THEN jsonb_build_object('marketplaceId', source->'catalogSourceId')
          ELSE '{}'::jsonb
        END
      WHERE source->>'kind' = 'catalog' OR source ? 'catalogSourceId';
  END IF;
END
$$;
