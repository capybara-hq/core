---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": minor
---

插件生命周期第二段集成评审修正：

- 安装记录先过权限闸门再导入模块：权限按审阅过的静态清单与迁移 SQL 判定，批准之前任何副本都不执行插件代码（含模块顶层代码）；导入后再核对 `manifest_mismatch`。
- `capybara plugins install` 先展示审阅（权限增减与迁移警告）并要求确认，`--yes` 跳过（脚本用）；未确认时只存包、不安装。
- 安装 / 启用 / 停用提交之后拼视图失败（如包在 CLI 读不到的对象存储里）不再报失败：返回降级视图（status failed、带 `error`），CLI 照常报成功并附说明。
