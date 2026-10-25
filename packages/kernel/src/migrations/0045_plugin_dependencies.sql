-- Phase 0b: a plugin's dependencies are installed in the org before it, each as its own
-- plugin_installs row, and recorded as a component of the parent install with kind 'plugin'
-- (ref = the dependency's install id). The CHECK is dropped and added back under the same name,
-- so a second run is a no-op.

-- capybara:allow-destructive the CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE plugin_install_components DROP CONSTRAINT IF EXISTS plugin_install_components_kind_check;
ALTER TABLE plugin_install_components ADD CONSTRAINT plugin_install_components_kind_check
  CHECK (kind IN ('extension', 'connector', 'skill', 'plugin'));
