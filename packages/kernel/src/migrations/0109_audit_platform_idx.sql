-- Platform-level audit events (org_id null), newest first: the admin overview's recent platform
-- operations and /admin/audit page by keyset on id (admin overview spec §4.4, §5.4). A plain
-- CREATE INDEX: the migrator runs each file in a transaction.
CREATE INDEX IF NOT EXISTS audit_events_platform_idx
  ON audit_events (id DESC) WHERE org_id IS NULL;
