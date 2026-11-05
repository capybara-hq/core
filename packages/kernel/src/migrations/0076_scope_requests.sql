-- Requests under plugin scope (phase 1, spec 2026-11-05-plugin-component-management-design.md
-- §5.1). A request has a kind: `access` (an org admin asks the enterprise admin to add the org to a
-- `named` item shown to other orgs), `import` (an org admin asks for a marketplace entry that is not
-- in the catalog yet: no item, the entry instead) or `enable` (a member asks the org admin to switch
-- an `optional` item on). Expand-only: `stage`, `version`, `org_decided_*` stay (the new code still
-- writes `stage` so the old NOT NULL and CHECK hold, and reads none of them).

-- Whether orgs outside a `named` item's list see it (as requestable). Never makes it usable.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS shown_to_others boolean NOT NULL DEFAULT true;

ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'access';
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_kind_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_kind_check
  CHECK (kind IN ('access', 'import', 'enable'));
-- An `import` request names a marketplace entry; its item is written when the import's confirm
-- commits.
ALTER TABLE catalog_requests ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS marketplace_id text
  REFERENCES marketplaces(id) ON DELETE SET NULL;
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS entry_name text;
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS entry_version text;
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_target_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_target_check
  CHECK (kind = 'import' AND entry_name IS NOT NULL OR kind <> 'import' AND item_id IS NOT NULL);
-- The optional reason of a rejection, shown to the requester.
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS reason text;
-- The prepared import of an approved `import` request (it resolves when that staging is confirmed;
-- a staging that expires leaves it pending).
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS staging_id uuid;
CREATE INDEX IF NOT EXISTS catalog_requests_staging_idx
  ON catalog_requests (staging_id) WHERE staging_id IS NOT NULL;
-- The requester dismissed the decision notice from the inbox.
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- One pending request per (org, kind, item or entry): replaces the old (org, item) index.
DROP INDEX IF EXISTS directory_requests_pending_uq;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_requests_pending_item_uq
  ON catalog_requests (org_id, kind, item_id)
  WHERE status = 'pending' AND item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_requests_pending_entry_uq
  ON catalog_requests (org_id, marketplace_id, entry_name)
  WHERE status = 'pending' AND kind = 'import';
CREATE INDEX IF NOT EXISTS catalog_requests_kind_idx
  ON catalog_requests (kind, status, created_at);
CREATE INDEX IF NOT EXISTS catalog_requests_requester_idx
  ON catalog_requests (org_id, requested_by) WHERE status IN ('approved', 'rejected');

-- Rows written before kinds: a member's request (stage org) was an `enable` one; decided requests
-- from before are not shown to their requesters as new decisions.
UPDATE catalog_requests SET kind = 'enable' WHERE stage = 'org' AND kind = 'access';
UPDATE catalog_requests SET dismissed_at = now()
  WHERE status <> 'pending' AND dismissed_at IS NULL;
