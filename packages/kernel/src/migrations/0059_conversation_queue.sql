-- UI refresh B (Task 9): queued messages. A queued message is not in the event log until it is sent
-- (the model has not seen it); it is conversation state another replica may dispatch, so it lives
-- here. `content` holds the blocks after the text (`@` resources read at queue time, uploaded file
-- refs); `attachments` the `@` resource metadata for user_message.payload.attachments; `files` the
-- uploaded files' display metadata. queue_paused: a run failed or was stopped with items queued.
CREATE TABLE IF NOT EXISTS capybara.conversation_queue (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  position bigint NOT NULL,
  text text NOT NULL,
  content jsonb NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  files jsonb NOT NULL DEFAULT '[]',
  client_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS conversation_queue_position_idx
  ON capybara.conversation_queue (conversation_id, position);
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS queue_paused boolean NOT NULL DEFAULT false;
