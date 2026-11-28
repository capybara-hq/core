-- Personal inbox items (collaboration spec 2026-11-25 §4.9): an item for one person in one org,
-- posted by the kernel (a depth stop, §4.7; a declined offer, §4.4) or by an extension through
-- `ctx.inbox.post`. Only that person lists it, clicks its actions or dismisses it.
-- - `actions`: at most three `{ id, label: { zh, en }, style?, uiAction: { contribution,
--   actionId, payload? } }`; a click calls the plugin's UI action as the person who clicked;
-- - `dedupe_key`: while an item with the same key is open for the same person, source and plugin,
--   a post returns it instead of adding another (the partial unique index);
-- - `expires_at`: past it the item leaves the inbox (read as gone; no sweep needed to hide it);
-- - `detail`: a kernel item's structured facts the web renders in its own copy (a declined offer:
--   who declined, for which agent); null for a plugin item.
-- The push category `inbox` joins the CHECK of 0188 (dropped and added in this file's one
-- transaction). The table carries `org_id` and its `org_scope` policy (still dark: nothing enables
-- row level security before phase 5).

CREATE TABLE IF NOT EXISTS inbox_items (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('kernel', 'plugin')),
  -- the posting extension; null for a kernel item
  plugin text,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  detail jsonb,
  CHECK ((source = 'plugin') = (plugin IS NOT NULL))
);

-- a person's open items (the inbox read)
CREATE INDEX IF NOT EXISTS inbox_items_open_idx
  ON inbox_items (org_id, account_id) WHERE state = 'open';

-- one open item per (org, account, source, plugin, dedupe key)
CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_dedupe_uq
  ON inbox_items (org_id, account_id, source, coalesce(plugin, ''), dedupe_key)
  WHERE state = 'open' AND dedupe_key IS NOT NULL;

DROP POLICY IF EXISTS org_scope ON inbox_items;
CREATE POLICY org_scope ON inbox_items USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE push_preferences DROP CONSTRAINT IF EXISTS push_preferences_category_check;
ALTER TABLE push_preferences ADD CONSTRAINT push_preferences_category_check
  CHECK (category IN ('waiting', 'replies', 'tasks', 'automations', 'inbox'));
