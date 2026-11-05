-- A person archives a conversation (hidden from the default lists, still readable and unarchived
-- by a new message) or deletes it (soft: hidden everywhere for the owner; the event log, runs and
-- trajectories stay for enterprise admins).
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS conversations_live_idx
  ON capybara.conversations (org_id, account_id, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
