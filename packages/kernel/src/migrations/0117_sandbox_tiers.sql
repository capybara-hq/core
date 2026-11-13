-- Sandbox tiers (sandbox dev tiers spec §7.2, §12). A cloud device's own tier: null follows the
-- org's default. A local device keeps its tier in its machine's policy.json, never here.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tier text;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_tier_check;
ALTER TABLE devices ADD CONSTRAINT devices_tier_check CHECK (tier IN ('strict', 'dev', 'open'));

-- The limits in force on the device's instance, `{ tier, egress }`, written by the fenced create
-- (or the file system create, for a provider whose limits apply there) and by an applied
-- `update`. Null (instances made before this migration) differs from every effective tier, so
-- the first use after the upgrade applies the new one.
ALTER TABLE device_instances ADD COLUMN IF NOT EXISTS instance_limits jsonb;
