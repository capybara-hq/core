-- One org's audit events, newest first: the org settings' audit log and the super admin's view of
-- an org page by keyset on id (org audit trail, design review 2026-11-16). A plain CREATE INDEX:
-- the migrator runs each file in a transaction.
CREATE INDEX IF NOT EXISTS audit_events_org_id_idx
  ON audit_events (org_id, id DESC) WHERE org_id IS NOT NULL;
