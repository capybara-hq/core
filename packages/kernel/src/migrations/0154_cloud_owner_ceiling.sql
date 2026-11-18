-- The cloud per-device authority of permission runtime cutover B1 (expand only). A cloud
-- device's owner ceiling (`owner_full_access`) and its outer network (`outer_network`, `{ kind:
-- "open-public" | "allowlist", hosts }`) are a snapshot of the old effective auto-mode authority,
-- written once per device by the snapshot writer under the device's exclusive lifecycle lease;
-- NULL: not snapshotted yet (the old `mode` choice still applies). `permission_migration` records
-- the provenance (the old effective policy and what was known of the instance). A device whose
-- applied limits were unknown, stale, wider or pending a reset carries
-- `permission_reconcile_required`: no operation is admitted until a lifecycle action establishes
-- the exact limits.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS owner_full_access boolean;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS outer_network jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS permission_migration jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS permission_reconcile_required boolean NOT NULL
  DEFAULT false;
