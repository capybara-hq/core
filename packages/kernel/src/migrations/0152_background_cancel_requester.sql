-- Who asked for a managed task's cancellation (permission runtime cutover phase 8.3). A stop that
-- cannot settle at once (no exact ref yet, or the provider persisted a pending cancellation) is
-- finished later by another path; that finish must keep the requester's wake rule: a person's,
-- a deletion's or an ended sub-agent's stop never wakes the conversation, a tool's or a revocation's
-- may. NULL: no stop asked (a revocation's cancellation, or none).
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS cancel_requested_by text;
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_cancel_requested_by_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_cancel_requested_by_check
  CHECK (cancel_requested_by IS NULL
    OR cancel_requested_by IN ('tool','person','conversation_deleted','subagent_end'));
-- When an exact stop of the task was last attempted: owed cancellations are applied least
-- recently attempted first, so one that keeps failing never holds the head of the queue.
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS cancel_attempted_at timestamptz;
