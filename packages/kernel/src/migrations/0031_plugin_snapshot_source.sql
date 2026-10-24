-- M6 T13：网页批准插件权限（D8），快照来源加 'web'。0016 的 CHECK 是内联匿名约束（默认名
-- plugin_permission_snapshots_source_check），先删后加；整个文件在一个事务里，可重复执行。
ALTER TABLE plugin_permission_snapshots
  DROP CONSTRAINT IF EXISTS plugin_permission_snapshots_source_check;
ALTER TABLE plugin_permission_snapshots
  ADD CONSTRAINT plugin_permission_snapshots_source_check CHECK (source IN ('cli', 'auto', 'web'));
