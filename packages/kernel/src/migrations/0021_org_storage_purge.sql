-- M5 T2：组织软删除后，维护任务按 storage.purgeDeletedOrgsAfterDays 清理其对象存储（storage/purge.ts）。
-- storage_purged_at 记录已清理的时间，之后不再处理该组织。
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS storage_purged_at timestamptz;
CREATE INDEX IF NOT EXISTS orgs_storage_purge_pending_idx
  ON orgs (deleted_at)
  WHERE deleted_at IS NOT NULL AND storage_purged_at IS NULL;
