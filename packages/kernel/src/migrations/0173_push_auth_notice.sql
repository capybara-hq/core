-- The platform notice `push_auth_failed` (mobile app spec §9.2, push plan task C6): a push
-- provider's credentials were refused on a delivery, so the super admins are told. Expand-only:
-- the kind check widens, and a partial unique index keeps at most one open notice per plugin, so
-- deliveries failing on several replicas at once insert one (`ON CONFLICT DO NOTHING`).
ALTER TABLE platform_notices DROP CONSTRAINT IF EXISTS platform_notices_kind_check;
ALTER TABLE platform_notices ADD CONSTRAINT platform_notices_kind_check
  CHECK (kind IN ('ownership_transferred', 'push_auth_failed'));
CREATE UNIQUE INDEX IF NOT EXISTS platform_notices_push_auth_open_idx
  ON platform_notices ((detail ->> 'plugin'))
  WHERE kind = 'push_auth_failed' AND dismissed_at IS NULL;
