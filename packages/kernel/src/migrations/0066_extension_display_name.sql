-- The plugin.json `displayName` ({ zh, en }) of an extension package, written when the package is
-- stored; NULL when the plugin has none and for packages stored before this migration (no
-- backfill: a name arrives with the next version). Additive: older replicas never read it.
ALTER TABLE capybara.extension_packages ADD COLUMN IF NOT EXISTS display_name jsonb;
