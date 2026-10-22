---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": minor
---

插件生命周期第二段集成评审修正：

- 安装记录先过权限闸门再导入模块：权限按审阅过的静态清单与迁移 SQL 判定，批准之前任何副本都不执行插件代码（含模块顶层代码）；导入后再核对 `manifest_mismatch`。
- `capybara plugins install` 先展示审阅（权限增减与迁移警告）并要求确认，`--yes` 跳过（脚本用）；未确认时只存包、不安装。
- 安装 / 启用 / 停用提交之后拼视图失败（如包在 CLI 读不到的对象存储里）不再报失败：返回降级视图（status failed、带 `error`），CLI 照常报成功并附说明。
- 模型供应商插件在流式输出途中被重新加载 / 升级：被中止的调用（`PluginUnloadedError`）归为可重试的 `run.provider_unavailable`，降级梯子的同模型重试取到新实例，运行照常完成。
- 安装记录不受信任：启动时 setup 同样限 `pluginHost.reloadSetupTimeoutSeconds`（内置与配置声明的照旧不限）；新增配置 `pluginHost.migrationTimeoutSeconds`（默认 300）：插件迁移会话设 `statement_timeout` / `lock_timeout`，到时终止会话、释放迁移锁并记 `migration_failed`。
- 插件名归属（Ruling P3 补充）：内置与配置声明的插件启动时按其 npm 包名登记 `plugin_name_owners`（已有不动）；名字没有归属却已有权限快照、部署配置或组织配置时，安装同样返回 `plugin.name_conflict`。
- 副本正常停机时删掉自己的 `plugin_replica_status` 行（原先标为 unloaded，后台在心跳过期前约 3 个周期里一直显示收敛中）；崩溃的副本仍按心跳清理。
- 迁移审阅新增警告种类 `foreign_schema`（引用内核 schema `capybara`、`GRANT` / `REVOKE`、角色、`ALTER DEFAULT PRIVILEGES`、`SET ROLE`、建函数 / 过程 / 触发器、事务控制），标敏感、不拒绝；`reviewHash` 并入警告摘要（没有警告时不变），审阅后警告变了按 `plugin.approval_stale` 拒绝批准。`splitSqlStatements` 的结果新增 `quoted`（双引号标识符原文）。
