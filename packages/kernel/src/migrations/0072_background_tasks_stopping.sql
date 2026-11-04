-- Background Bash: a stop claims its task before it signals the session (stopping_at), so the
-- poller, which skips a claimed task, cannot finish it meanwhile from what the signals leave
-- behind (no process, or the wrapper's exit status); the stop's own finish is then the only one.
-- A launch that finds its reservation claimed kills the command it started at once.
ALTER TABLE IF EXISTS capybara.background_tasks ADD COLUMN IF NOT EXISTS stopping_at timestamptz;
