-- Phase C: the expiry of a run's sub-agents wait (spec §7.2), so the wait sweep can expire it when
-- its timeout job was lost (approvals and questions keep theirs in their own rows). Set when a run
-- suspends on a `subagents` wait, cleared when it resumes. Additive and nullable: older versions
-- ignore it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS wait_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS runs_wait_expires_idx ON runs (wait_expires_at)
  WHERE status = 'waiting' AND wait_expires_at IS NOT NULL;
