-- Agent map spec §6 (changed in acceptance 2026-11-13): a person's stop of a root conversation
-- stops its whole sub-agent tree and holds the tree's wakes. Set on the root by that stop, cleared
-- when the root next starts a run; while set, no sub-agent delivery wakes the root and no
-- sub-agent of its tree starts a run. Null on every existing row (no stop is held).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tree_stopped_at timestamptz;
