-- Agent templates, phase 4 (spec 2026-11-05-plugin-component-management-design.md §15.2: P4-7
-- connector_setup requests, P4-8 provenance). Expand-only: every new column is nullable, existing
-- rows keep their shape, and the only dropped objects are two checks replaced in this file.

-- P4-8: where an agent came from. Display data only (no FK: the template may be deleted or
-- renamed later), written when an agent is created from a template.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_from_template_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_from_template_version int;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_from_template_name text;

-- P4-7: a `connector_setup` request asks an org admin to set up the connectors an agent made from a
-- template needs (`pending_keys`: the template's connector keys still without an instance). It
-- names its agent and no item or marketplace entry.
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS agent_id text
  REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS pending_keys jsonb;

-- capybara:allow-destructive the check is added back with `connector_setup` in the next statement; existing rows (access, import, enable) satisfy it
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_kind_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_kind_check
  CHECK (kind IN ('access', 'import', 'enable', 'connector_setup'));

-- item_id is already nullable (0077). The target check of 0077 required an item for every kind but
-- `import`; a connector_setup row needs an agent instead.
-- capybara:allow-destructive the check is added back with the connector_setup branch in the next statement; existing rows satisfy its first and third branches
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_target_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_target_check
  CHECK (
    kind = 'import' AND entry_name IS NOT NULL
    OR kind = 'connector_setup' AND agent_id IS NOT NULL
      AND item_id IS NULL AND entry_name IS NULL
    OR kind NOT IN ('import', 'connector_setup') AND item_id IS NOT NULL
  );

-- `pending_keys` is a JSON array of keys when set.
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_pending_keys_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_pending_keys_check
  CHECK (pending_keys IS NULL OR jsonb_typeof(pending_keys) = 'array');

-- At most one pending setup request per agent (P4-7).
CREATE UNIQUE INDEX IF NOT EXISTS catalog_requests_pending_setup_uq
  ON catalog_requests (agent_id) WHERE kind = 'connector_setup' AND status = 'pending';

CREATE INDEX IF NOT EXISTS catalog_requests_agent_idx
  ON catalog_requests (agent_id) WHERE agent_id IS NOT NULL;
