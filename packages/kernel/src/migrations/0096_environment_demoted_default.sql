-- A default environment demoted by a sandbox provider switch (environments spec §4.2 item 13)
-- records the provider it was demoted from; NULL for every other environment. The UI names such an
-- environment after the default plus that provider's display name (「个人环境（Docker 沙箱）」), and
-- when the deployment switches back to that provider the row is restored as the person's default.
ALTER TABLE capybara.environments ADD COLUMN IF NOT EXISTS demoted_from_provider text;

-- Backfill: until now a demoted default was renamed `Personal (<provider>)` (` 2`, ` 3`, … when
-- taken). Those rows get the marker and lose the generated name. A person-made environment with
-- such a name is caught too; that is accepted before 0.1.0 (AGENTS.md "Before 0.1.0": no real
-- users yet). Idempotent: a backfilled row has a NULL name and no longer matches.
UPDATE capybara.environments
   SET demoted_from_provider = substring(name FROM '^Personal \(([^)]+)\)'),
       name = NULL
 WHERE owner_kind = 'personal'
   AND NOT is_default
   AND deleted_at IS NULL
   AND demoted_from_provider IS NULL
   AND name ~ '^Personal \([^)]+\)( [0-9]+)?$';
