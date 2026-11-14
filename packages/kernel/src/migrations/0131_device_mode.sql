-- Auto mode (auto mode spec §4.3, direction check 2026-11-14): a cloud device's mode switch only
-- narrows the network. A cloud device follows the platform and the org (NULL, auto when allowed) or
-- is narrowed to sandbox mode ('sandbox'), which applies the org's `cloudNetwork` to its network.
-- Auto mode is never stored: turning it on is the platform's and the org's decision, and a local
-- device's mode lives in its machine's local policy.json, not here.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_mode_check;
ALTER TABLE devices ADD CONSTRAINT devices_mode_check
  CHECK (mode IS NULL OR mode = 'sandbox');
