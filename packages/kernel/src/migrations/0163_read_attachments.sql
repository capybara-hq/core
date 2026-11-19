-- Images the builtin Read stores with the calling conversation (vision-read design §1.3): a new
-- purpose 'read', kept under read-images/<id> and purged after the conversation is deleted.
ALTER TABLE capybara.attachments DROP CONSTRAINT IF EXISTS attachments_purpose_check;
ALTER TABLE capybara.attachments
  ADD CONSTRAINT attachments_purpose_check
  CHECK (purpose IN ('chat', 'skill-package', 'agent-avatar', 'read'));
-- The hourly read purge looks up conversations deleted long enough ago; a partial index keeps the
-- lookup off the live conversations.
CREATE INDEX IF NOT EXISTS conversations_deleted_idx ON capybara.conversations (deleted_at)
  WHERE deleted_at IS NOT NULL;
