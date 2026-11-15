-- Project root (project root design §4.1, §4.3, §12): a device's projects live in PostgreSQL, keyed
-- by the device's id, the same for a local machine and a cloud device. The kernel is the only
-- writer; the device program keeps no project list of its own. A project's identity on its device
-- is its name; its path is absolute on the device. Deleted with its device row.
CREATE TABLE IF NOT EXISTS device_projects (
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name text NOT NULL,
  path text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, name)
);

-- The owner's home directory a local machine reports in its hello (`DeviceHello.home`): the base
-- of an auto-mode project's relative path. NULL: not reported (cloud devices have none).
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS home text;

-- A conversation may be bound, at creation, to one project of its device (design §4.3). The name
-- and the path it resolved to are both stored, so re-pointing the name later does not move an
-- existing conversation. NULL: free mode.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_name text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_path text;

-- Every sandbox tool call and every command review of a bound conversation reads the root
-- conversation's latest `project_root` event (its working root, design §4.3); the event is not
-- rewritten while nothing changes, so without this partial index the lookup scans the conversation's
-- events backwards. Not CONCURRENTLY, like the other index migrations (0025, 0094).
CREATE INDEX IF NOT EXISTS conversation_events_project_root_idx
  ON conversation_events (conversation_id, seq)
  WHERE type = 'project_root';
