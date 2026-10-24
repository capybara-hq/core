-- Phase 0a terminology: app bundles become plugins. app_installs / app_install_components /
-- app_import_staging become plugin_installs / plugin_install_components / plugin_import_staging
-- (plugin_installs is free since 0041 renamed the old one to extension_installs). A component's
-- kind 'plugin' (an extension the bundle installed) becomes 'extension'. Index, FK and PK names are
-- not renamed (as in 0033). No compatibility views (nothing is released yet).

-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS app_installs RENAME TO plugin_installs;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS app_install_components RENAME TO plugin_install_components;
-- capybara:allow-destructive table rename; code is renamed in the same release (project not released, no compatibility layer)
ALTER TABLE IF EXISTS app_import_staging RENAME TO plugin_import_staging;

-- kind 'plugin' -> 'extension': drop the CHECK (under its 0037 name, or ours on a second run),
-- rewrite the rows, add it back. The whole file runs in one transaction, so this is repeatable.
ALTER TABLE plugin_install_components DROP CONSTRAINT IF EXISTS app_install_components_kind_check;
ALTER TABLE plugin_install_components DROP CONSTRAINT IF EXISTS plugin_install_components_kind_check;
UPDATE plugin_install_components SET kind = 'extension' WHERE kind = 'plugin';
ALTER TABLE plugin_install_components ADD CONSTRAINT plugin_install_components_kind_check
  CHECK (kind IN ('extension', 'connector', 'skill'));
