-- Plugin scope phase 2, Task 5: the migration of org copies to platform components
-- (`catalog/platform-migration.ts`, the worker job `platform-components-migrate`), and the org
-- notices it writes for the org admins' inbox.

-- The catalog version the item's platform components were last written from
-- (`PlatformComponents.syncFromVersion`); null = never: the migration job writes them once. Removed
-- components are not brought back, since an item with a version here is never synced by the job.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS platform_synced_version text;

-- One row per run of the job (at every worker start and once a day): when it ran and what it
-- changed; rows older than 30 days are pruned, except the first finished run, whose start is the
-- cutoff of the one-shot rename step (only org skills whose current version predates it).
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
