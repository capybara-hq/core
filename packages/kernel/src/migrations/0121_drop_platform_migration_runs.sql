-- 0121, transactional outbox spec §8.2: the platform components migration job is gone (an import
-- writes its platform components in its transaction), so nothing writes its runs table any more and
-- the platform inbox no longer shows a run; the org notice kind `skill_renamed`, which only that job
-- wrote, goes with it.
-- capybara:allow-destructive the job that wrote this table is removed in this release and nothing reads it (project not released, no compatibility layer)
DROP TABLE IF EXISTS platform_migration_runs;
-- capybara:allow-destructive notices of a kind only the removed job wrote; the inbox no longer renders the kind (project not released)
DELETE FROM org_notices WHERE kind = 'skill_renamed';
-- capybara:allow-destructive the check is added back without `skill_renamed` in the next statement; no row has that kind any more
ALTER TABLE org_notices DROP CONSTRAINT IF EXISTS org_notices_kind_check;
ALTER TABLE org_notices ADD CONSTRAINT org_notices_kind_check
  CHECK (kind IN ('item_shared', 'shared_item_updated', 'upload_confirmed', 'upload_rejected'));
