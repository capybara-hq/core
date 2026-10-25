-- Phase A1: org in-place upgrades of installed plugins (package ecosystem spec §10).
-- - plugin_installs.status gains 'upgrading' (set under the org lock while an upgrade runs; one
--   upgrade or uninstall per install at a time).
-- - plugin_installs.upgrade: the journal of the running upgrade ({ id, from, to, startedAt, done }),
--   NULL otherwise. A replica that crashed midway leaves it behind; once older than
--   catalog.staleInstallMinutes it is undone (the install back at its old version).
-- - plugin_install_components.template_id: the connector template a connector component was
--   created from (NULL for other kinds and for installs before this migration), so an upgrade maps
--   a template to its connector.
-- - plugin_install_components.dropped: a component an upgrade removed from the plugin but kept
--   because an agent uses it ("no longer in the plugin").
-- The status CHECK was created inline in 0037 under the table's name at the time (0043 renamed the
-- table, not the constraint), so it is found by its definition, dropped and added back under a
-- fixed name in the same transaction; a second run is a no-op.

-- capybara:allow-destructive the status CHECK is re-added with one more allowed value in the same transaction
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'plugin_installs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE plugin_installs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE plugin_installs ADD CONSTRAINT plugin_installs_status_check
  CHECK (status IN ('installing', 'installed', 'failed', 'uninstalling', 'upgrading'));
ALTER TABLE plugin_installs ADD COLUMN IF NOT EXISTS upgrade jsonb NULL;

ALTER TABLE plugin_install_components ADD COLUMN IF NOT EXISTS template_id text NULL;
-- An upgrade that removes a skill or connector an agent still uses keeps it, marked "no longer in
-- the plugin"; the install still owns it (uninstall removes it once nothing uses it).
ALTER TABLE plugin_install_components ADD COLUMN IF NOT EXISTS dropped boolean NOT NULL DEFAULT false;
