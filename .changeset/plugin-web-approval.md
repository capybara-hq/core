---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
---

插件列表与网页批准权限：内核新增迁移 `0031_plugin_snapshot_source`（快照来源加 `web`）、`GET /api/v1/admin/plugins`（及 `/:name`，返回 `AdminPluginView`：来源、期望状态、各副本状态、推导出的部署级状态、权限分组、相对快照的增减、`reviewHash`、敏感标记与快照）与 `POST /api/v1/admin/plugins/:name/approve`（核对 `sha256` 与 `reviewHash`，写快照与审计 `plugin.permissions_approved`，发布 `kernel.plugins.changed`，本副本随即加载；错误码 `plugin.approval_stale`、`plugin.not_pending`，内置插件返回 `plugin.builtin`）；`SENSITIVE_CAPABILITIES` 增加 `sandbox@1` 与 `object-store@1`；`PluginHost.inspect` 支持 `builtin`，新增 `declaredPlugins()` 与 `activatePending()`。CLI 的 `capybara plugins review / approve` 把内置插件视为预先批准（不列出、approve 提示无需批准），提供敏感能力的项标 `(sensitive)`。
