-- Environments phase 1 (spec 2026-11-07-environments-design §4.2, §10): a long-lived environment
-- is one sandbox instance plus a file system kept until the environment is deleted. This replaces
-- the per-conversation `sandboxes` table with `environment_instances`; the old table stays only
-- for the cleanup job that destroys its remaining instances. The CHECK lists of owner_kind and
-- source grow in phases 2 and 3 through new migrations.
CREATE TABLE IF NOT EXISTS capybara.environments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('personal')),
  owner_account_id text NOT NULL REFERENCES capybara.accounts(id),
  name text,
  is_default boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('cloud')),
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS environments_default_uq
  ON capybara.environments (org_id, owner_account_id)
  WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS environments_name_uq
  ON capybara.environments (org_id, owner_account_id, lower(name))
  WHERE name IS NOT NULL AND deleted_at IS NULL;

-- Same columns and meaning as the old sandboxes table (0023), keyed by environment. fs_handle and
-- fs_status describe the kept file system; status 'none' means no instance exists yet.
CREATE TABLE IF NOT EXISTS capybara.environment_instances (
  environment_id text PRIMARY KEY REFERENCES capybara.environments(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  provider text,
  fs_handle jsonb,
  fs_status text NOT NULL DEFAULT 'none' CHECK (fs_status IN ('none', 'ready', 'lost')),
  handle jsonb,
  status text NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'creating', 'running', 'suspended', 'destroyed')),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  running_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  destroyed_at timestamptz,
  generation integer NOT NULL DEFAULT 0,
  had_instance boolean NOT NULL DEFAULT false,
  prev_provider text,
  prev_handle jsonb,
  sweep_failed_at timestamptz
);
CREATE INDEX IF NOT EXISTS environment_instances_running_idx
  ON capybara.environment_instances (last_used_at)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS environment_instances_live_idx
  ON capybara.environment_instances (last_used_at)
  WHERE status <> 'destroyed';
CREATE INDEX IF NOT EXISTS environment_instances_org_idx
  ON capybara.environment_instances (org_id);

-- The environment a member's new conversations use when they pick none.
CREATE TABLE IF NOT EXISTS capybara.environment_defaults (
  org_id text NOT NULL,
  account_id text NOT NULL,
  environment_id text NOT NULL REFERENCES capybara.environments(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);

-- No cascade: a deleted environment is soft-deleted and the conversation keeps pointing at it.
ALTER TABLE capybara.conversations
  ADD COLUMN IF NOT EXISTS environment_id text REFERENCES capybara.environments(id);

ALTER TABLE capybara.background_tasks ADD COLUMN IF NOT EXISTS environment_id text;
CREATE INDEX IF NOT EXISTS background_tasks_environment_running_idx
  ON capybara.background_tasks (environment_id) WHERE status = 'running';

-- Tasks that ran in a per-conversation sandbox lose it with the move to environments (the
-- instances are destroyed by the cleanup job).
UPDATE capybara.background_tasks
  SET status = 'lost',
      lost_reason = COALESCE(lost_reason, 'sandbox_replaced_by_environment'),
      finished_at = COALESCE(finished_at, now())
  WHERE status = 'running';
