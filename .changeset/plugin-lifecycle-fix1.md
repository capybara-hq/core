---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

插件生命周期修正：插件名归 npm 包所有，卸载后另一个 npm 包用同名插件安装返回 `plugin.name_conflict`（数据、密钥与批准保留给原来的包）；包审阅结果新增 `warnings`，列出迁移里的破坏性语句（敏感警告，不拒绝；检测逻辑移入内核 `splitSqlStatements` / `isDestructiveSql`，`tools/checks` 复用）；停机时后台排空中的旧实例在 `lifecycleWaitMs` 后强制撤销；reconcile 开始时也刷新心跳；运行中的插件迁移随宿主关闭中止；去掉不再使用的 `PluginInstalls.markMigrated`。CLI `install` 打印破坏性迁移警告。
