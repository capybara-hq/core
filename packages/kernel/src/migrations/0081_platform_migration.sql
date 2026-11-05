-- Plugin scope phase 2, Task 5: the migration of org copies to platform components
-- (`catalog/platform-migration.ts`, the worker job `platform-components-migrate`), and the org
-- notices it writes for the org admins' inbox.

-- One row per run of the job (at every worker start and once a day): when it ran and what it
-- changed. Nothing reads it to decide anything; every step of the job is idempotent on its own.
CREATE TABLE IF NOT EXISTS platform_migration_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- A notice for an org's admins (inbox item kind = `kind`), until one of them dismisses it.
-- `skill_renamed`: detail `{ skillId, from, to, platformSkillId, plugin }`.
CREATE TABLE IF NOT EXISTS org_notices (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('skill_renamed')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by text REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS org_notices_open_idx
  ON org_notices (org_id, created_at DESC)
  WHERE dismissed_at IS NULL;
