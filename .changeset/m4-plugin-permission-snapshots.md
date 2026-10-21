---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/capybara": minor
---

- 插件权限快照与待批准（扩展模型 7.3）：新表 `capybara.plugin_permission_snapshots`（迁移 `0016_plugin_permissions.sql`）。`computePermissionSet` 汇总 provides / requires / optional、两级配置字段（路径与是否密钥）、迁移 SQL 中 `CREATE TABLE` 的表名与清单 `permissions` 各项，`diffPermissions` 按稳定键（如 `permissions.tools:write`、`table:todos`、`config.org.secret:apiKey`）比较。
- `PluginHost.load` 在迁移与 setup 之前比对快照：无快照或比快照多出任何一项 → 不加载，记入 `host.pending()` 并打 warn；`requires` 只能由这些插件满足的插件同样不加载（reason `dependency`，带 `blockedBy`）；`optional` 依赖照常加载；权限变少或不变直接加载并更新快照。`PluginHost.migrateOnly` / `migrateAll` 走同一道闸门（待批准的插件不迁移，经 `onPending` 报告）。新增 `PluginHost.inspect`（只导入清单并计算权限集合，不迁移不 setup）。
- 新配置 `pluginPermissions.autoApprove`（默认 false，非热更新）：为 true 时自动写快照（source `auto`），启动日志醒目提示；仅用于开发与试用。
- CLI：`capybara plugins review` 列出待批准插件与新增项；`capybara plugins approve <name> [--yes]` 终端确认后写快照（source `cli`）并记审计 `plugin.permissions_approved`，提示重启内核生效。`capybara migrate` 对未迁移的待批准插件打 warn。
- 测试工具：双副本 harness 默认开启 `pluginPermissions.autoApprove`（可经 `config` 覆盖）。
- 未声明 `permissions.secrets` 时 `ctx.secrets` 改为不可枚举的抛错 getter：展开 / 打印 ctx 不再触发越权与审计。
