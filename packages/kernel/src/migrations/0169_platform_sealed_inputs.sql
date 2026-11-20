-- Platform web parity (spec 2026-11-19-platform-web-parity-design.md §4.3): values a person types on
-- an approval card for a Platform call's secret fields, sealed until the resumed call consumes them
-- once. Expand-only.
--
-- One row per approval, written in the decision's transaction. The values are one JSON object
-- sealed with the master keyring (AES-256-GCM, AAD = approval id plus the sorted field paths in
-- `paths`, so a row whose paths are altered fails to unwrap). Only the recipient (the person who
-- typed them) may consume the row; the resumed call deletes it in the transaction that applies the
-- write, and the hourly cleanup job drops rows past expires_at (15 minutes after the decision).
CREATE TABLE IF NOT EXISTS capybara.platform_sealed_inputs (
  approval_id text PRIMARY KEY REFERENCES capybara.approvals(id) ON DELETE CASCADE,
  recipient_account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  call_id text NOT NULL,
  paths text[] NOT NULL,
  master_key_id text NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sealed_inputs_expires_idx
  ON capybara.platform_sealed_inputs (expires_at);
