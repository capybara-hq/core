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
