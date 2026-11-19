-- The device sandbox no longer reads a cloud device's B1 snapshot network (`outer_network`), so
-- the copy 0165 made runs once more for cloud devices snapshotted after it (approval-only profiles
-- design, "Migration"): a device still following its org whose snapshot ran on an allowlist gets
-- `network_mode = 'allowlist'` and the snapshot's hosts as `network_hosts` when they are a
-- non-empty array of strings; an empty or unreadable allowlist ran closed and becomes `none`.
-- Never wider: a device's host list only narrows its org's hosts. Only rows still following the
-- org are written, so a rerun never overwrites a later choice. The snapshot writer copies new
-- snapshots itself from now on, and the device sandbox reads a snapshot an older replica writes
-- later while the device has no choice of its own.
UPDATE devices
SET network_mode = CASE
      WHEN jsonb_typeof(outer_network -> 'hosts') = 'array'
        AND jsonb_array_length(outer_network -> 'hosts') > 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(outer_network -> 'hosts') AS h(v)
          WHERE jsonb_typeof(h.v) <> 'string'
        )
      THEN 'allowlist'
      ELSE 'none'
    END,
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
