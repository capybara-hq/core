-- Org-layer network requests (network ask-to-allow spec §5.3, plan decision P-D6): a member asks the
-- org admins to add hosts to the org's sandbox egress allowlist. A `network_allowlist` request names
-- no item, entry or agent; `detail` holds what it asks for ({ hosts, conversationId, agentId }).
-- Expand-only: the new column is nullable and the dropped checks are added back, wider, in this file.

ALTER TABLE catalog_requests ADD COLUMN IF NOT EXISTS detail jsonb;

-- capybara:allow-destructive the check is added back with `network_allowlist` in the next statement; existing rows satisfy it
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_kind_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_kind_check
  CHECK (kind IN ('access', 'import', 'enable', 'connector_setup', 'network_allowlist'));

-- capybara:allow-destructive the check is added back with the network_allowlist branch in the next statement; existing rows satisfy its other branches
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_target_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_target_check
  CHECK (
    kind = 'import' AND entry_name IS NOT NULL
    OR kind = 'connector_setup' AND agent_id IS NOT NULL
      AND item_id IS NULL AND entry_name IS NULL
    OR kind = 'network_allowlist' AND detail IS NOT NULL
      AND item_id IS NULL AND agent_id IS NULL AND entry_name IS NULL
    OR kind NOT IN ('import', 'connector_setup', 'network_allowlist') AND item_id IS NOT NULL
  );

-- `detail` is a JSON object when set.
ALTER TABLE catalog_requests DROP CONSTRAINT IF EXISTS catalog_requests_detail_check;
ALTER TABLE catalog_requests ADD CONSTRAINT catalog_requests_detail_check
  CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object');
