-- @ conversations (spec §1): a message referencing another conversation reads that conversation's
-- latest `compaction_summary` at send time, as do skill loads (`invokedInContext`); a summary is
-- written rarely, so without this partial index the lookup scans the conversation's events
-- backwards. `conversation_events` has no `org_id`, so no RLS policy. Not CONCURRENTLY, like the
-- other index migrations (0025, 0094, 0133).
CREATE INDEX IF NOT EXISTS conversation_events_compaction_summary_idx
  ON conversation_events (conversation_id, seq)
  WHERE type = 'compaction_summary';
