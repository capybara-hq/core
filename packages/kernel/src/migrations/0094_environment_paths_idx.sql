-- Environments phase 2 (spec 2026-11-07-environments-design §13.1, ruling R22): every sandbox tool
-- call reads the conversation's latest environment_paths event; a partial index answers it
-- without scanning the conversation's events backwards. Not CONCURRENTLY, like the other index
-- migrations (0025).
CREATE INDEX IF NOT EXISTS conversation_events_environment_paths_idx
  ON conversation_events (conversation_id, seq)
  WHERE type = 'environment_paths';
