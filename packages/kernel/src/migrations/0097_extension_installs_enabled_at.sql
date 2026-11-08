-- When an install record's desired state last became `enabled` (NULL while disabled). A
-- single-provider extension point (sandbox, object-store, secret-store, config-source) takes one
-- enabled provider; enabling a second one is refused. A deployment that already has two enabled
-- (enabled before that rule) loads the one enabled first on every replica and after every restart,
-- never the first by name. `updated_at` cannot tell: an upgrade or a source change rewrites it.
ALTER TABLE extension_installs ADD COLUMN IF NOT EXISTS enabled_at timestamptz;

-- Backfill the enabled rows: the latest `extension.enabled` audit of the extension (every enable
-- path writes one), else the install time. Idempotent: a filled row is skipped.
UPDATE extension_installs i
   SET enabled_at = COALESCE(
         (SELECT max(a.at) FROM audit_events a
           WHERE a.action = 'extension.enabled' AND a.target = i.name),
         i.installed_at)
 WHERE i.desired_state = 'enabled'
   AND i.enabled_at IS NULL;
