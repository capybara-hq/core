-- Plugin scope phase 2, Task 11: the plugin scope sync's open failures, for the super admin's
-- inbox (`catalog/scope-sync.ts` writes them, `inbox/platform-inbox.service.ts` reads them). One row
-- per (item, org) whose last sync attempt failed; the next sync of that pair that does not fail
-- deletes it. The audit event `plugin.scope_sync_failed` stays the history.
CREATE TABLE IF NOT EXISTS plugin_scope_sync_failures (
  item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  op text NOT NULL CHECK (op IN ('install', 'uninstall')),
  code text NOT NULL,
  message text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, org_id)
);
