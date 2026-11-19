-- A cloud device's own sandbox network (approval-only profiles design, "Settings model" and
-- "Migration"; expand only). `network_mode` is the device's choice, `open` or `allowlist`; NULL
-- follows the org. `network_hosts` is the device's allowlist (a JSON array of host patterns),
-- used while the mode is `allowlist`. The device owner or an org admin changes both, within the
-- org and platform ceilings. A cloud device has no outside of its sandbox, so `owner_full_access`
-- is no longer read; a later migration drops it (expand, then contract).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_mode text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_hosts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_network_mode_check;
ALTER TABLE devices ADD CONSTRAINT devices_network_mode_check
  CHECK (network_mode IS NULL OR network_mode IN ('open', 'allowlist'));
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_network_hosts_check;
ALTER TABLE devices ADD CONSTRAINT devices_network_hosts_check
  CHECK (jsonb_typeof(network_hosts) = 'array');

-- Never wider: a device's host list only narrows its org's effective hosts, never adds to them,
-- so a cloud device whose B1 snapshot ran on an allowlist keeps exactly that allowlist (hosts
-- that are not an array of strings become an empty list, which adds no narrowing of its own; the
-- device still runs on the allowlist); an open or missing snapshot follows the org. Only rows
-- still following the org are written, so a rerun never overwrites a later choice.
UPDATE devices
SET network_mode = 'allowlist',
    network_hosts = CASE
      WHEN jsonb_typeof(outer_network -> 'hosts') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(outer_network -> 'hosts') AS h(v)
          WHERE jsonb_typeof(h.v) <> 'string'
        )
      THEN outer_network -> 'hosts'
      ELSE '[]'::jsonb
    END
WHERE source = 'cloud'
  AND network_mode IS NULL
  AND outer_network ->> 'kind' = 'allowlist';
