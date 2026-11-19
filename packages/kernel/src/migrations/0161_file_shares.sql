-- File shares (file sharing spec §1): a link to a frozen snapshot of one conversation file. A row
-- is kept after it is revoked or expired (the audit trail and the lists' recent section);
-- `object_key` is cleared once the sweep frees the snapshot. Whether a share is live (creator
-- still has access, external sharing still allowed) is checked at open time, not stored.
-- `last_opened_at` backs the Shares pages' "last opened" column.
CREATE TABLE IF NOT EXISTS file_shares (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- the artifact version or attachment the current generation was copied from (no foreign key:
  -- the source may be removed while the snapshot lives on)
  file_id text NOT NULL,
  -- delivered files: the version group (`sourcePath`); null for uploads
  source_path text,
  created_by text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('internal', 'external')),
  name text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  object_key text,
  generation integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text REFERENCES accounts(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IN
    ('creator', 'admin', 'conversation_deleted', 'member_offboarded', 'creator_lost_access')),
  last_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS file_shares_code_key ON file_shares (code);
CREATE INDEX IF NOT EXISTS file_shares_org_creator_idx ON file_shares (org_id, created_by);
CREATE INDEX IF NOT EXISTS file_shares_conversation_idx ON file_shares (conversation_id);
CREATE INDEX IF NOT EXISTS file_shares_org_live_idx ON file_shares (org_id) WHERE revoked_at IS NULL;
