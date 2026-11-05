-- Background Bash: a launch reserves its row (status running, counted against
-- sandbox.background.maxTasks under a transaction-scoped lock) before the launch exec, and sets
-- sid and sandbox_created_at once the command started. A row without a sid is a reservation: the
-- poller skips it, and a failed launch finishes it as failed.
ALTER TABLE IF EXISTS capybara.background_tasks ALTER COLUMN sid DROP NOT NULL;
ALTER TABLE IF EXISTS capybara.background_tasks ALTER COLUMN sandbox_created_at DROP NOT NULL;
