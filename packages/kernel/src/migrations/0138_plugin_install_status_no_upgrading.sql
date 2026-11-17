-- Design review 2026-11-16 (live-install-set-copied-with-dead-status): `plugin_installs.status`
-- loses 0049's `upgrading`. Nothing has written it since the per-org upgrade went (ruling F2: a
-- platform plugin is updated once for the deployment), and the code that cleaned up an interrupted
-- one is removed with this migration.
-- - A row still `upgrading` becomes `installed`, as the removed cleanup treated it (it undid the
--   upgrade's journal, then uninstalled it as an installed plugin, not as a rollback). It counted
--   as live before and stays live, so no scope work is owed. The platform update already moved
--   its version to the platform's.
-- - `plugin_installs.upgrade` (the per-org upgrade journal) is cleared: no code reads or writes it
--   any more. The column itself stays for the replicas of the previous release (expand ->
--   contract); a later migration drops it.
-- - The status CHECK (named by 0049) is re-added without `upgrading`. Idempotent: the updates
--   match nothing on a second run, the drop takes IF EXISTS.
UPDATE plugin_installs SET status = 'installed', upgrade = NULL WHERE status = 'upgrading';
UPDATE plugin_installs SET upgrade = NULL WHERE upgrade IS NOT NULL;
ALTER TABLE plugin_installs DROP CONSTRAINT IF EXISTS plugin_installs_status_check;
ALTER TABLE plugin_installs ADD CONSTRAINT plugin_installs_status_check
  CHECK (status IN ('installing', 'installed', 'failed', 'uninstalling'));
