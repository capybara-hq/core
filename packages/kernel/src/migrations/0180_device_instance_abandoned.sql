-- Issue #675: a device instance whose provider plugin is no longer installed on this deployment
-- (no extension_installs row, or its catalog item removed) can never be destroyed by the kernel.
-- Deleting its device marks the row abandoned instead of retrying forever: abandoned_at is when,
-- and the row keeps the provider-side names (handle, fs_handle, prev_handle) for the super admin.
-- NULL for every other row. A provider of that name installed again destroys it as before.
ALTER TABLE device_instances ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;
