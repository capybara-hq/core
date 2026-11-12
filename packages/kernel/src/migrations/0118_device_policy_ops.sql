-- The `policy` ops the platform sent to a machine whose answer may not be recorded yet (sandbox dev
-- tiers spec §10.4): a summary the machine reports by itself (a `policy` frame, the next hello)
-- that is such an op's change is not listed again as a change made on the machine. A JSON array of
-- `{ id, add, remove, tier?, isolation?, until }`; an entry leaves when its answer is recorded or,
-- unanswered, when `until` (epoch ms) has passed.
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS pending_policy_ops jsonb NOT NULL DEFAULT '[]'::jsonb;
