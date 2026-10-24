-- Phase 0b: the catalog holds one kind, the plugin (package ecosystem spec §4). Every catalog row
-- before this migration is in a pre-0.1.0 format (an extension tgz, a skill / connector-template
-- package, an app.yaml bundle) that 0b no longer reads, so the catalog content is removed and the
-- tables lose their kind:
-- - deleted, in FK order: org plugin installs and their components, requests, grants, extension
--   catalog sources, import staging, versions, items, cached marketplace entries (refetched at the
--   next refresh: each marketplace's ETag is cleared and its status reset to 'never'). Org skills / connectors / skill versions and deployment extension installs stay,
--   with their catalog link set to NULL. Objects under deployment/directory/ are left in object
--   storage, unreachable.
-- - catalog_items: no kind; one live item per name.
-- - catalog_item_versions: manifest (the normalized plugin.json), no section / resolved,
--   plugin_sha256 becomes extension_sha256.
-- - marketplace_entries: no kind; one entry is one version, keyed (source_id, name, version) with
--   '' for an entry without a version (marketplace.json §5.2); npm is NULL for non-npm sources.
-- - plugin_import_staging: manifest instead of bundle.
-- The deletes run only while catalog_items still has its kind column, so a second run is a no-op.

-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'capybara' AND table_name = 'catalog_items' AND column_name = 'kind'
  ) THEN
    DELETE FROM capybara.plugin_install_components;
    DELETE FROM capybara.plugin_installs;
    DELETE FROM capybara.catalog_requests;
    DELETE FROM capybara.catalog_org_grants;
    DELETE FROM capybara.extension_catalog_sources;
    DELETE FROM capybara.plugin_import_staging;
    UPDATE capybara.connectors SET catalog_item_id = NULL, catalog_version = NULL
      WHERE catalog_item_id IS NOT NULL OR catalog_version IS NOT NULL;
    UPDATE capybara.skills SET catalog_item_id = NULL, catalog_version = NULL
      WHERE catalog_item_id IS NOT NULL OR catalog_version IS NOT NULL;
    UPDATE capybara.skill_versions SET catalog_item_id = NULL, catalog_version = NULL
      WHERE catalog_item_id IS NOT NULL OR catalog_version IS NOT NULL;
    UPDATE capybara.extension_installs SET catalog_item_id = NULL
      WHERE catalog_item_id IS NOT NULL;
    DELETE FROM capybara.catalog_item_versions;
    DELETE FROM capybara.catalog_items;
    DELETE FROM capybara.marketplace_entries;
    -- The entries are gone, so the next refresh must not get a 304 for them
    UPDATE capybara.marketplaces SET etag = NULL, last_status = 'never', last_error = NULL
      WHERE etag IS NOT NULL OR last_status <> 'never';
  END IF;
END
$$;

-- catalog_items: one kind; the live-name index moves from (kind, name) to name.
DROP INDEX IF EXISTS directory_items_live_name_uq;
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
ALTER TABLE catalog_items DROP COLUMN IF EXISTS kind;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_live_name_uq
  ON catalog_items (name)
  WHERE deleted_at IS NULL;

-- catalog_item_versions: the normalized plugin manifest; the extension's package.
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL;
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
ALTER TABLE catalog_item_versions DROP COLUMN IF EXISTS section;
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
ALTER TABLE catalog_item_versions DROP COLUMN IF EXISTS resolved;
-- RENAME COLUMN has no IF EXISTS: check information_schema first, so a second run does nothing.
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'capybara' AND table_name = 'catalog_item_versions'
      AND column_name = 'plugin_sha256'
  ) THEN
    ALTER TABLE capybara.catalog_item_versions RENAME COLUMN plugin_sha256 TO extension_sha256;
  END IF;
END
$$;

-- marketplace_entries: one entry per (source, name, version).
ALTER TABLE marketplace_entries DROP CONSTRAINT IF EXISTS catalog_entries_pkey;
ALTER TABLE marketplace_entries DROP CONSTRAINT IF EXISTS marketplace_entries_pkey;
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
ALTER TABLE marketplace_entries DROP COLUMN IF EXISTS kind;
ALTER TABLE marketplace_entries ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '';
ALTER TABLE marketplace_entries ALTER COLUMN npm DROP NOT NULL;
ALTER TABLE marketplace_entries
  ADD CONSTRAINT marketplace_entries_pkey PRIMARY KEY (source_id, name, version);

-- plugin_import_staging: the plugin manifest instead of the app bundle.
-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released
ALTER TABLE plugin_import_staging DROP COLUMN IF EXISTS bundle;
ALTER TABLE plugin_import_staging ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL;
