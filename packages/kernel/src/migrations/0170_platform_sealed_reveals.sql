-- Platform web parity (spec 2026-11-19-platform-web-parity-design.md §7.2, plan ruling R10): a
-- value a Platform call made that only the person who approved the call may read, once, on the
-- web, like the generated initial password (account_initial_passwords). The first kind is
-- `invitation_link`: the token of an invitation an org admin's agent created. Expand-only.
--
-- One row per value, keyed by the subject it belongs to (the invitation id). The value is sealed
-- with the master keyring (AES-256-GCM, AAD = the subject id, so a row moved to another subject
-- fails to unwrap). The tool call it came from (conversation_id, run_id, call_id: a call id is
-- unique only within its run) and its recipient decide who may read it. Read once (deleted as it
-- is read), dropped after expires_at (24 hours) by the hourly cleanup job.
CREATE TABLE IF NOT EXISTS capybara.platform_sealed_reveals (
  id text PRIMARY KEY,
  kind text NOT NULL,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  recipient_account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  call_id text NOT NULL,
  master_key_id text NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sealed_reveals_call_idx
  ON capybara.platform_sealed_reveals (conversation_id, run_id, call_id);
CREATE INDEX IF NOT EXISTS platform_sealed_reveals_expires_idx
  ON capybara.platform_sealed_reveals (expires_at);
