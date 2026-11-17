-- 0057 already owns the unique (org_id, account_id, create_request_id) index.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS create_request_hash text;
