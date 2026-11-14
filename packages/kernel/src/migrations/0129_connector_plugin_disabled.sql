-- A connector's plugin was switched off in its org: the connector is kept with its endpoint and
-- credentials but disabled, and marked with the plugin (the catalog item) that switched it off, so
-- switching the plugin back on re-enables exactly the connectors it disabled. A connector an org
-- admin disabled by hand has no marker (null) and stays disabled.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS disabled_by_plugin_id uuid;
