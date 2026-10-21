---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

插件界面第一档（渲染 schema）的内核实现：`ctx.ui.view` / `action`（只在 setup 期间、按 `permissions.ui.views`）与 `invalidate`（经内核 bus 发 `conv.<id>` / `org-ui.<orgId>` 的 `{kind:"ui"}` 刷新）；新接口 `GET /api/v1/orgs/:orgId/ui/contributions`、`GET …/ui/views/:plugin/:id`、`POST …/ui/actions/:plugin/:id`、`GET …/ui/stream`（组织级 SSE），会话流新增 `event: ui` 帧；动作 `ui.use`（HUMAN_ONLY）；错误码 `ui.not_found` / `ui.render_failed` / `ui.action_failed` / `ui.invalid_view` / `ui.timeout`（render / action 5 秒时限）。权限快照新增 `ui.view:*`（不卡加载，升级时自动补进快照）与 `ui.embed:*`（卡加载），权限清单新增 `ui` 分组（含 embed 时敏感），`capybara plugins approve` 同样不要求批准只多出视图的插件；`plugins review / approve` 按与权限清单相同的规则给敏感项标 `(sensitive)`（`isSensitivePermissionKey`）。工具显示摘要：`tool_result` 事件新增可选 `display`（校验不过即丢弃并告警，不进模型请求），内置工具 `ask_user` / `read_tool_output` / `tool_search` 与 resources 工具给出中英文摘要。

`ctx.ui.invalidate` 先用一条查询核对目标：插件在该组织启用、带对话时对话属于该组织；不满足只记 debug、不发刷新。
