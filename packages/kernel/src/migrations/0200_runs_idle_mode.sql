-- Compaction model (compaction model spec §6.1): the mode of an idle compact run, decided when
-- its job was armed; null on every other run.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS idle_mode text NULL
  CONSTRAINT runs_idle_mode_check CHECK (idle_mode IN ('cache', 'compaction_model'));
