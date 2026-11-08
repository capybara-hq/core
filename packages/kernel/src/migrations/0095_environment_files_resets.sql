-- How many times an environment's files were reset. A provider may give the new file system the id
-- of the destroyed one (sandbox-docker names its volumes after the environment), so the kernel
-- counts resets itself: a conversation that last used the environment under another count is told
-- its files were reset, not that the instance restarted on kept files.
ALTER TABLE capybara.environment_instances ADD COLUMN IF NOT EXISTS fs_resets integer NOT NULL DEFAULT 0;
