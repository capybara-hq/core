-- UI refresh B (Task 7): model-generated titles and create-on-first-send.
-- title_source: who wrote `title` (null = nobody yet; a manual rename is never regenerated).
-- title_attempts: title-generation attempts made (bounded retry, claimed per attempt).
-- create_request_id: the first message's clientMessageId, so a retried first send is idempotent.
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS title_source text
  CHECK (title_source IN ('generated', 'manual'));
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS title_attempts int NOT NULL DEFAULT 0;
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS create_request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_create_request_idx
  ON capybara.conversations (org_id, account_id, create_request_id)
  WHERE create_request_id IS NOT NULL;
