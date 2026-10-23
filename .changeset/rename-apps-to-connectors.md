---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

**破坏性变更（D17）**：「应用 / app」（已安装的远端服务实例）改名「连接器 / connector」，一次改完，不留兼容层（C28）。

- HTTP：`/api/v1/orgs/:orgId/apps*` → `/api/v1/orgs/:orgId/connectors*`（含 `preview`、`prompts`、`resources`、`:connectorId/connect` 等），旧路径一律 404。响应字段 `app` / `apps` → `connector` / `connectors`；审批视图的 `app` → `connector`；消息接口 `attachments[].appId` → `connectorId`。安装 / 预览的 6 MiB 请求体上限跟随新路由（内核 `LARGE_BODY_ROUTES` 与网页代理）。
- 权限与错误码：`OrgAction` `apps.manage` / `apps.use` → `connectors.manage` / `connectors.use`；错误码 `app.not_found` / `slug_taken` / `connect_failed` / `tool_not_found` / `tool_not_pending` / `resources_disabled` → `connector.*`；OAuth 回跳错误码 `app_unavailable` → `connector_unavailable`。
- 审计：新记录写 `connector.created` / `updated` / `deleted` / `tools_refreshed` / `tools_drifted` / `tool_reviewed` / `credential.set` / `credential.cleared`；旧记录 `app.*` 不改，`auditActionAliases` 按显式映射表视为同义（不按前缀）。
- 数据库：迁移 `0033_rename_apps_to_connectors.sql` 把 `apps` → `connectors`、`app_tools` → `connector_tools`、`connector_tools` / `tool_grants` / `conversation_tool_grants` / `approvals` 的 `app_id` → `connector_id`；索引与约束名不变。
- agent 定义：工具引用改为 `{ kind: "connector", connectorId, tools }`；旧形 `{ kind: "app", appId, tools }` 仍可提交与读取，读入时规范化，新保存只写新形。
- 不变（C27，日志确定性与已存数据）：模型可见的英文文案、事件 payload 的 `appId` / `appName`、secrets 键 `credentials:app:*`、slug 与工具 key。改名前录制的会话由 `reconstructRequest` 还原零漂移（夹具测试）。
- 网页：`/apps*` 页面改为 `/connectors*`，一级导航「连接器」，i18n 键 `apps.*` → `connectors.*`，中文文案「应用」→「连接器」。
