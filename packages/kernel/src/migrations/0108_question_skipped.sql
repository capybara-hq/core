-- A message from the run's starter closes a pending question as skipped (reply-while-question spec
-- §6.2). Widening the inline CHECK of 0010 (PG's default name questions_status_check): drop and add
-- in the file's one transaction, idempotent.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('pending', 'answered', 'skipped', 'expired', 'cancelled'));
