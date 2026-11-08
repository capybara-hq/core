-- Environments phase 2 (spec 2026-11-07-environments-design §6, §13): a person's own machine,
-- connected through the device program, becomes an environment with source 'device'. Expand-only:
-- the source CHECK list grows and a new table holds the connected machine.

-- 0088 left the CHECK unnamed, so Postgres named it environments_source_check; re-add it under
-- the same name with the longer list.
ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_source_check;
ALTER TABLE environments
  ADD CONSTRAINT environments_source_check CHECK (source IN ('cloud', 'device'));

-- The machine connected to a device environment. credential_hash is a hash of the machine's long-lived
-- credential (cap_dev_...), never the credential itself; revoking a machine sets revoked_at and keeps the row, so
-- only one unrevoked machine exists per environment. program_version, mode, roots and
-- session_isolation are what the program reported on its last connection; last_seen_at is the
-- last time it connected or pinged.
CREATE TABLE IF NOT EXISTS environment_machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  environment_id text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  os text NOT NULL,
  arch text NOT NULL,
  program_version text,
  mode text CHECK (mode IN ('os', 'docker')),
  roots jsonb,
  session_isolation boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS environment_machines_active_uq
  ON environment_machines (environment_id)
  WHERE revoked_at IS NULL;
