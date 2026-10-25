-- Phase A2: bootstrap plugins replace built-in extensions (package ecosystem spec §7).
-- - Source 'bootstrap' for packages, install records, permission snapshots and catalog versions
--   written by the bootstrap step (packages baked into the image, pinned by packages/kernel/
--   bootstrap.json).
-- - extension_installs.required: a required bootstrap plugin is enabled in every org without an
--   org config row and cannot be disabled or uninstalled (the bootstrap step sets and clears it).
-- - extension_replica_status: the kernel no longer loads 'builtin' extensions; a bootstrap plugin
--   is an install record and is reported as 'install'. The status table is rebuilt by each
--   replica's reconcile, so the 'builtin' rows are dropped.
-- - bootstrap_runs: one row per manifest (sha256 of bootstrap.json) the bootstrap step completed;
--   "bootstrap done" = a row for the current manifest.
-- Every CHECK is dropped under each name it may have (its creation name, or ours on a second run)
-- and added back in the same transaction, so a second run is a no-op.

-- capybara:allow-destructive the source CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE extension_packages DROP CONSTRAINT IF EXISTS extension_packages_source_check;
ALTER TABLE extension_packages ADD CONSTRAINT extension_packages_source_check
  CHECK (source IN ('npm', 'file', 'catalog', 'bootstrap'));

-- capybara:allow-destructive the source CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE extension_installs DROP CONSTRAINT IF EXISTS extension_installs_source_check;
ALTER TABLE extension_installs ADD CONSTRAINT extension_installs_source_check
  CHECK (source IN ('npm', 'file', 'catalog', 'bootstrap'));

-- capybara:allow-destructive the source CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE extension_permission_snapshots
  DROP CONSTRAINT IF EXISTS plugin_permission_snapshots_source_check;
ALTER TABLE extension_permission_snapshots
  DROP CONSTRAINT IF EXISTS extension_permission_snapshots_source_check;
ALTER TABLE extension_permission_snapshots ADD CONSTRAINT extension_permission_snapshots_source_check
  CHECK (source IN ('cli', 'auto', 'web', 'bootstrap'));

-- capybara:allow-destructive the source CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE catalog_item_versions DROP CONSTRAINT IF EXISTS catalog_item_versions_source_check;
ALTER TABLE catalog_item_versions ADD CONSTRAINT catalog_item_versions_source_check
  CHECK (source IN ('file', 'npm', 'marketplace', 'git', 'bootstrap'));

-- capybara:allow-destructive replica status rows are rebuilt by every replica's reconcile; 'builtin' is no longer a load source
DELETE FROM extension_replica_status WHERE source = 'builtin';
-- capybara:allow-destructive the source CHECK is re-added without 'builtin' in the same transaction
ALTER TABLE extension_replica_status DROP CONSTRAINT IF EXISTS plugin_replica_status_source_check;
ALTER TABLE extension_replica_status
  DROP CONSTRAINT IF EXISTS extension_replica_status_source_check;
ALTER TABLE extension_replica_status ADD CONSTRAINT extension_replica_status_source_check
  CHECK (source IN ('config', 'install'));

ALTER TABLE extension_installs ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bootstrap_runs (
  manifest_sha256 text PRIMARY KEY CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL,
  results jsonb NOT NULL
);
