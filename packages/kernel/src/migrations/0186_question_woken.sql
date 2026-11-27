-- Watched input waits (browser long waits spec §5.2): a tool's watcher settles the question as
-- `woken`. Widening the CHECK of 0108 (drop and add in the file's one transaction, idempotent).
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('pending', 'answered', 'skipped', 'expired', 'cancelled', 'woken'));
