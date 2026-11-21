-- Device providers (spec 2026-11-21-device-provider-design): what a device's provider last told
-- about it (`device-provider@1` `report()`, a DeviceReport as JSON) and when. Shown to people
-- only, never used for enforcement; request paths read this copy and never call the provider.
-- Expand-only, no backfill: null until the device's next create or resume refreshes it.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS report jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS report_at timestamptz;
