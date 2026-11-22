-- Device provider phase 2 (dial-in contract): local device semantics leave the kernel for the
-- device-local plugin. The kernel keeps only a dial-in device's signed-in machine (its
-- credential and program facts); what the former local provider kept per machine, its instance
-- bindings and boot history, and the device's location column go.
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS features;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS local_policy;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS owner_report;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS pending_policy_ops;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS home;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS roots;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS mode;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE device_machines DROP COLUMN IF EXISTS session_isolation;
-- The former @local provider kept nothing of its own (a local device's files live on its machine)
-- and no provider can destroy its instance rows any more: they go, so deleting such a device
-- settles at once. The device itself stays bound to @local (unavailable until its owner deletes it).
-- capybara:allow-destructive the @local provider is gone and held no resources; no loaded provider can ever destroy these rows
DELETE FROM device_instances WHERE provider = '@local';
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
DROP TABLE IF EXISTS device_machine_boots;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
DROP TABLE IF EXISTS device_instance_bindings;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_source_check;
-- capybara:allow-destructive local device semantics moved to device-local; project not released, no compatibility layer
ALTER TABLE devices DROP COLUMN IF EXISTS source;
