-- Idle compaction (idle compaction spec §5.7): which compact runs were started by the idle job.
-- null = an ordinary run; a compact run written before this migration reads as manual.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS compact_origin text NULL
  CONSTRAINT runs_compact_origin_check CHECK (compact_origin IN ('manual', 'idle'));
-- The person's opt-out (spec §6.3): 'off' or null (follow the org).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS idle_compaction text NULL
  CONSTRAINT accounts_idle_compaction_check CHECK (idle_compaction = 'off');
