-- Phase 0a terminology: the kernel's plugin domain becomes the extension domain. The nine plugin_*
-- tables are renamed to extension_* (plugin_directory_sources -> extension_catalog_sources); the
-- `plugin` text columns keep their name (the value is the extension's name). Index, FK and PK names
-- are not renamed (as in 0033). The package / install `source` value 'directory' becomes 'catalog'.
-- PG schemas plugin_<name> are not touched. No compatibility views (nothing is released yet).

-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_packages RENAME TO extension_packages;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_blobs RENAME TO extension_blobs;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_installs RENAME TO extension_installs;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_name_owners RENAME TO extension_name_owners;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_replica_status RENAME TO extension_replica_status;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_permission_snapshots RENAME TO extension_permission_snapshots;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_org_configs RENAME TO extension_org_configs;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_deployment_configs RENAME TO extension_deployment_configs;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS plugin_directory_sources RENAME TO extension_catalog_sources;

-- source 'directory' -> 'catalog': drop the CHECK (under its 0030 name, or ours on a second run),
-- rewrite the rows, add it back. The whole file runs in one transaction, so this is repeatable.
ALTER TABLE extension_packages DROP CONSTRAINT IF EXISTS plugin_packages_source_check;
ALTER TABLE extension_packages DROP CONSTRAINT IF EXISTS extension_packages_source_check;
UPDATE extension_packages SET source = 'catalog' WHERE source = 'directory';
ALTER TABLE extension_packages ADD CONSTRAINT extension_packages_source_check
  CHECK (source IN ('npm', 'file', 'catalog'));

ALTER TABLE extension_installs DROP CONSTRAINT IF EXISTS plugin_installs_source_check;
ALTER TABLE extension_installs DROP CONSTRAINT IF EXISTS extension_installs_source_check;
UPDATE extension_installs SET source = 'catalog' WHERE source = 'directory';
ALTER TABLE extension_installs ADD CONSTRAINT extension_installs_source_check
  CHECK (source IN ('npm', 'file', 'catalog'));
