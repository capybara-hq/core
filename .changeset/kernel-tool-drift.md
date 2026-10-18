---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-connector-mcp": minor
"@capybara-hq/testing": minor
---

工具定义漂移检测与复核（spec 7.3）：维护队列每 `tools.driftIntervalHours` 小时（job scheduler `drift-scan-interval`，多副本只有一个）对活动应用重新 listTools，与快照比对——新增工具 `pending_review`；定义变化 → `pending_review`（新定义存 `pending_spec`，旧定义保留供对比）；消失 → 停用并标记 `missing`。`POST /api/v1/orgs/:orgId/apps/:appId/refresh` 改走同一套比对；新增 `POST .../apps/:appId/tools/:name/review {action: "approve" | "reject"}`（`apps.manage`，错误码 `app.tool_not_found` / `app.tool_not_pending`），approve 采用新定义并启用、默认策略按新注解重新推导（管理员设定的策略保留，工具视图新增 `policySource` / `pending` / `missing` / `reviewedAt`），reject 停用并保留旧定义；待复核的工具不能经 PATCH 启用。审计 `app.tools_drifted`（只有计数）与 `app.tool_reviewed`。个人凭据型应用的后台检查依次试至多 3 个现任成员的个人凭据。迁移 `0015_tool_drift.sql`。

SDK：`ConnectorOpenArgs` 新增可选 `onToolsChanged?: () => void`（会话中远端报告工具清单变了时调用，内核投递一次漂移检查，jobId `drift-<appId>-<分钟桶>`）。connector-mcp：收到 `notifications/tools/list_changed` 时调用它。测试工具：`startFakeMcpServer` 新增 `sseResponses`，工具处理函数第二个参数 `ctx.notifyToolsChanged()`。
