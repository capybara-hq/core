-- Platform tool phase 2 (spec 2026-11-07-platform-tool-design.md §14.5 item 2): the super admin's
-- agent creates an account with a kernel-generated one-time password. Expand-only.
--
-- must_change_password: the account must set its own password before anything else (the auth
-- guard refuses every route but the password change, /me and logout until it does).
ALTER TABLE capybara.accounts ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- The generated password, sealed with the master keyring (AES-256-GCM, AAD = account id), waiting
-- for the person who approved the creation to read it once on the web. Keyed by the account; the
-- tool call it came from (conversation_id, call_id) and its recipient decide who may read it. Read
-- once (DELETE ... RETURNING), dropped when the account changes its password, and dropped after
-- expires_at (lazily, by the next creation).
CREATE TABLE IF NOT EXISTS capybara.account_initial_passwords (
  account_id text PRIMARY KEY REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  recipient_account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  master_key_id text NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_initial_passwords_call_idx
  ON capybara.account_initial_passwords (conversation_id, call_id);
