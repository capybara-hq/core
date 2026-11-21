-- Push notifications (spec 2026-11-20-mobile-app-design.md §9.3): a person's mobile app
-- registrations and their per-category push preferences. Expand-only.
--
-- A registration belongs to the account, not an org: one serves every org the person is in. It
-- records the session that posted it (revoking that session deletes it). The device's push token
-- is sealed with the master keyring (AES-256-GCM, AAD `capybara:push-token:<id>`, so a ciphertext
-- moved to another row fails to unwrap) and is unique per channel and app through its sha256 hash;
-- `capybara secrets rewrap` rewraps it after a master key rotation. A registration not seen for 60
-- days is deleted by a locked daily job (index on last_seen_at).
CREATE TABLE IF NOT EXISTS capybara.push_registrations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  session_id text REFERENCES capybara.sessions(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_id text NOT NULL,
  provider text NOT NULL,
  token_hash text NOT NULL,
  master_key_id text NOT NULL,
  token_ciphertext bytea NOT NULL,
  locale text NOT NULL CHECK (locale IN ('zh', 'en')),
  device_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, app_id, token_hash)
);
CREATE INDEX IF NOT EXISTS push_registrations_account_idx
  ON capybara.push_registrations (account_id);
CREATE INDEX IF NOT EXISTS push_registrations_session_idx
  ON capybara.push_registrations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_registrations_last_seen_idx
  ON capybara.push_registrations (last_seen_at);

-- One row per category the person switched; an absent row means the category is on.
CREATE TABLE IF NOT EXISTS capybara.push_preferences (
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('waiting', 'replies', 'tasks', 'schedules')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, category)
);
