-- Conversation process blocks: how an IM channel shows a run's process. Per connection,
-- 'detailed' | 'brief' | 'off'; NULL follows the chat type (direct chats detailed, groups brief).
ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS process_display text
  CHECK (process_display IN ('detailed', 'brief', 'off'));
-- The run's one progress message, edited in place: its IM message id, the run it belongs to and
-- when its last milestone was sent, so any replica delivering the conversation edits the same one.
ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_message_id text;
ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_run_id text;
ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS milestone_at timestamptz;
-- The run's progress card was posted again after the platform rejected an edit (once per run).
ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_reposted boolean NOT NULL DEFAULT false;
-- The ended run's card got its final edit (or the platform refused it for good): leave it alone.
ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_final boolean NOT NULL DEFAULT false;
