-- Agent avatar uploads reuse the presigned attachment flow: a new purpose 'agent-avatar' and the
-- agent whose profile uses the upload (set once on save; a used upload has no expiry).
ALTER TABLE capybara.attachments DROP CONSTRAINT IF EXISTS attachments_purpose_check;
ALTER TABLE capybara.attachments
  ADD CONSTRAINT attachments_purpose_check
  CHECK (purpose IN ('chat', 'skill-package', 'agent-avatar'));
ALTER TABLE capybara.attachments ADD COLUMN IF NOT EXISTS agent_id text;
