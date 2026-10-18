---
"@capybara-hq/kernel": minor
---

新增工具相关数据表（迁移 `0010_tools.sql`：`apps`、`app_tools`、`tool_grants`、`conversation_tool_grants`、`approvals`、`questions`、`tool_outputs`，`runs.status` 增加 `waiting`，`orgs.settings`）、`tools` 配置段与 `http.publicUrl`；组织动作新增 `apps.manage`（admin）、`apps.use`（guest）、`approvals.decide`（guest），均仅限用户主体；错误码 `app.*`、`approval.*`、`question.*`、`tool_output.not_found`、`credential.missing`。
