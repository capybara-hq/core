-- 插件组织配置：没有配置时存 NULL（而不是 '{}'），区分「从未配置」与「配置为空对象」。
ALTER TABLE plugin_org_configs ALTER COLUMN config DROP NOT NULL;
ALTER TABLE plugin_org_configs ALTER COLUMN config DROP DEFAULT;
