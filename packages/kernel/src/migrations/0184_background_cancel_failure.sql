-- Why a managed task's owed stop did not settle at its last attempt (fix 2026-11-25, core#846):
-- 'unreachable' when the device did not answer in time or its machine is not connected, 'failed'
-- when the device or its provider refused or failed the stop; NULL when no attempt failed (none
-- yet, or the device recorded the cancellation and applies it later). The task view and the
-- TaskStop result say which; the detail is the failure's message, clipped.
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS cancel_failure text;
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_cancel_failure_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_cancel_failure_check
  CHECK (cancel_failure IS NULL OR cancel_failure IN ('unreachable','failed'));
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS cancel_failure_detail text;
