-- Account profile (spec 2026-11-20-account-profile-design §5.1): a person's own avatar and the
-- uploads behind it. Expand-only.

-- null: no own avatar (the SSO avatar or the initial shows); else {"kind":"upload","uploadId":…}
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar jsonb;

-- Avatar uploads of an account. Not `attachments`: an attachment needs an org, an account has
-- none of its own. An unbound upload carries `expires_at`; the bound one has none.
CREATE TABLE IF NOT EXISTS account_avatar_uploads (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  size bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_avatar_uploads_account_idx
  ON account_avatar_uploads (account_id);
CREATE INDEX IF NOT EXISTS account_avatar_uploads_expires_idx
  ON account_avatar_uploads (expires_at) WHERE expires_at IS NOT NULL;

-- When an identity row was last written (insert or login refresh): the SSO avatar shown is the
-- one of the most recently refreshed identity. Null for rows written before this migration.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS updated_at timestamptz;
