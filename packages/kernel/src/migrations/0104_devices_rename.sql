-- One name: devices (spec 2026-11-07-environments-design §15.2). Every environment table, column,
-- index and constraint takes the device name; a connected machine's source 'device' becomes
-- 'local', the kernel-internal provider '@device' becomes '@local', and the log event
-- 'environment_paths' becomes 'device_paths' (in the log and in eval case snapshots). The kernel
-- is renamed in the same release; before 0.1.0, so no compatibility layer and no rolling deploy
-- across this migration. Every statement is guarded, so a rerun changes nothing.

-- capybara:allow-destructive table rename; the kernel is renamed in the same release (not released, no compatibility layer)
ALTER TABLE IF EXISTS environments RENAME TO devices;
-- capybara:allow-destructive table rename; the kernel is renamed in the same release (not released, no compatibility layer)
ALTER TABLE IF EXISTS environment_instances RENAME TO device_instances;
-- capybara:allow-destructive table rename; the kernel is renamed in the same release (not released, no compatibility layer)
ALTER TABLE IF EXISTS environment_defaults RENAME TO device_defaults;
-- capybara:allow-destructive table rename; the kernel is renamed in the same release (not released, no compatibility layer)
ALTER TABLE IF EXISTS environment_machines RENAME TO device_machines;

-- RENAME COLUMN has no IF EXISTS: checked against information_schema first.
-- capybara:allow-destructive column rename environment_id -> device_id; the kernel is renamed in the same release (not released)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_instances', 'device_defaults', 'device_machines',
                           'conversations', 'background_tasks'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'capybara' AND table_name = t AND column_name = 'environment_id'
    ) THEN
      EXECUTE format('ALTER TABLE capybara.%I RENAME COLUMN environment_id TO device_id', t);
    END IF;
  END LOOP;
END
$$;

-- Indexes, including those behind the primary keys and unique constraints (renaming such an
-- index renames its constraint too).
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environments_pkey RENAME TO devices_pkey;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environments_default_uq RENAME TO devices_default_uq;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environments_name_uq RENAME TO devices_name_uq;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_instances_pkey RENAME TO device_instances_pkey;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_instances_running_idx RENAME TO device_instances_running_idx;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_instances_live_idx RENAME TO device_instances_live_idx;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_instances_org_idx RENAME TO device_instances_org_idx;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_defaults_pkey RENAME TO device_defaults_pkey;
-- capybara:allow-destructive index rename; names follow the column rename (not released)
ALTER INDEX IF EXISTS background_tasks_environment_running_idx RENAME TO background_tasks_device_running_idx;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_machines_pkey RENAME TO device_machines_pkey;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_machines_credential_hash_key RENAME TO device_machines_credential_hash_key;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_machines_active_uq RENAME TO device_machines_active_uq;
-- capybara:allow-destructive index rename; names follow the table rename (not released)
ALTER INDEX IF EXISTS environment_machines_org_idx RENAME TO device_machines_org_idx;

-- NOT NULL constraints are unnamed on PostgreSQL 17 (the target), so nothing to rename there.
-- The other CHECK and foreign key constraints: RENAME CONSTRAINT has no IF EXISTS, so each is
-- checked against pg_constraint first. The source CHECK is not renamed here: it is replaced
-- below with the new value list.
-- capybara:allow-destructive constraint rename; names follow the table and column renames (not released)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('devices', 'environments_org_id_fkey', 'devices_org_id_fkey'),
      ('devices', 'environments_owner_account_id_fkey', 'devices_owner_account_id_fkey'),
      ('devices', 'environments_owner_kind_check', 'devices_owner_kind_check'),
      ('device_instances', 'environment_instances_fs_status_check', 'device_instances_fs_status_check'),
      ('device_instances', 'environment_instances_status_check', 'device_instances_status_check'),
      ('device_instances', 'environment_instances_environment_id_fkey', 'device_instances_device_id_fkey'),
      ('device_defaults', 'environment_defaults_environment_id_fkey', 'device_defaults_device_id_fkey'),
      ('conversations', 'conversations_environment_id_fkey', 'conversations_device_id_fkey'),
      ('device_machines', 'environment_machines_mode_check', 'device_machines_mode_check'),
      ('device_machines', 'environment_machines_org_id_fkey', 'device_machines_org_id_fkey'),
      ('device_machines', 'environment_machines_environment_id_fkey', 'device_machines_device_id_fkey')
    ) AS v(tbl, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_namespace s ON s.oid = c.connamespace
      WHERE s.nspname = 'capybara' AND c.conname = r.old_name
    ) THEN
      EXECUTE format('ALTER TABLE capybara.%I RENAME CONSTRAINT %I TO %I',
                     r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END
$$;

-- A connected machine's source 'device' becomes 'local': the old CHECK goes, the rows change, and
-- the CHECK comes back under the new name with the new list.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS environments_source_check;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_source_check;
UPDATE devices SET source = 'local' WHERE source = 'device';
ALTER TABLE devices
  ADD CONSTRAINT devices_source_check CHECK (source IN ('cloud', 'local'));

-- The kernel-internal provider '@device' becomes '@local' wherever a provider name is stored.
UPDATE devices SET provider = '@local' WHERE provider = '@device';
UPDATE device_instances SET provider = '@local' WHERE provider = '@device';
UPDATE device_instances SET prev_provider = '@local' WHERE prev_provider = '@device';

-- The log event 'environment_paths' becomes 'device_paths' (its idempotency key prefix too); the
-- rows are updated first, so the old partial index (0094) finds them, then the index follows.
UPDATE conversation_events
  SET type = 'device_paths',
      idem_key = CASE
        WHEN idem_key LIKE 'environment_paths:%' THEN 'device_paths:' || substr(idem_key, 19)
        ELSE idem_key
      END
  WHERE type = 'environment_paths';
DROP INDEX IF EXISTS conversation_events_environment_paths_idx;
CREATE INDEX IF NOT EXISTS conversation_events_device_paths_idx
  ON conversation_events (conversation_id, seq)
  WHERE type = 'device_paths';

-- Eval case snapshots carry the events of their run: the same event type change, order kept.
-- snapshot_bytes is not recomputed: only type names change (a few bytes shorter), harmless.
UPDATE eval_cases
  SET snapshot = jsonb_set(snapshot, '{events}', (
    SELECT jsonb_agg(
      CASE WHEN e->>'type' = 'environment_paths' THEN jsonb_set(e, '{type}', '"device_paths"')
           ELSE e END
      ORDER BY ord)
    FROM jsonb_array_elements(snapshot->'events') WITH ORDINALITY AS t(e, ord)))
  WHERE snapshot @? '$.events[*] ? (@.type == "environment_paths")';
