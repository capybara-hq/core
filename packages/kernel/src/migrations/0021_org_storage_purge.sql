-- M5 T2：组织软删除后，维护任务按 storage.purgeDeletedOrgsAfterDays 清理其对象存储（storage/purge.ts）。
-- storage_purged_at 记录已清理的时间，之后不再处理该组织。
-- storage_purge_claimed_at 是某次运行的认领时间：认领在短事务里完成，删除对象在事务外进行；
-- 认领超时（运行中途退出）后可被重新认领。
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS storage_purged_at timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS storage_purge_claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS orgs_storage_purge_pending_idx
  ON orgs (deleted_at)
  WHERE deleted_at IS NOT NULL AND storage_purged_at IS NULL;
