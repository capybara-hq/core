-- 0122, transactional outbox spec §8.1 / §8.2: the transaction that writes a pending task run owes
-- its fire job in the outbox, so the scheduled task scan's repair is gone, and with it the column
-- that rotated the repair's rechecks of started runs.
-- capybara:allow-destructive the repair that read and wrote this column is removed in this release and nothing else reads it (project not released, no compatibility layer)
ALTER TABLE scheduled_task_runs DROP COLUMN IF EXISTS rechecked_at;
