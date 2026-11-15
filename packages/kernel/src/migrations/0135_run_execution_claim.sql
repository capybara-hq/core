-- A new acquisition of the same run revokes all older worker transactions.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_id text;
