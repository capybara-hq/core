-- Memory plugin spec §6.2: where a conversation comes from (web, channel_dm, channel_group,
-- subagent), set once at creation and never changed; extension tools and context@1 providers are
-- offered by it.
-- The column is added with a constant default, so existing rows read 'web' without a rewrite.
-- The backfill then sets the other sources, each UPDATE touching only rows still at 'web', so a
-- re-run updates nothing; later UPDATEs skip rows an earlier one set:
-- 1. kind 'subagent' -> subagent;
-- 2. a channel thread row of any archive state (DM /new archives the row, the conversation stays
--    a DM's): key 'dm:' -> channel_dm, any other key -> channel_group;
-- 3. a scheduled group run whose thread is still to bind at its first post (no thread row yet):
--    its delivery's target chat type.
-- The rest stays web. The CHECK is added last (dropped first, so a re-run re-adds it).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';

UPDATE conversations SET source = 'subagent'
WHERE kind = 'subagent' AND source = 'web';

UPDATE conversations c
SET source = CASE WHEN t.dm THEN 'channel_dm' ELSE 'channel_group' END
FROM (
  SELECT conversation_id, bool_or(thread_key LIKE 'dm:%') AS dm
  FROM channel_threads
  GROUP BY conversation_id
) t
WHERE t.conversation_id = c.id AND c.source = 'web';

UPDATE conversations c
SET source = CASE WHEN d.target->>'chatType' = 'dm' THEN 'channel_dm' ELSE 'channel_group' END
FROM channel_deliveries d
WHERE d.conversation_id = c.id AND d.target->>'chatType' IN ('dm', 'group') AND c.source = 'web';

-- capybara:allow-destructive the CHECK is re-added unchanged right below (a re-run of this file)
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_source_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_source_check
  CHECK (source IN ('web', 'channel_dm', 'channel_group', 'subagent'));
