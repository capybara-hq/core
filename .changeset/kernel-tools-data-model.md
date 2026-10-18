---
"@capybara-hq/kernel": minor
---

新增工具相关数据表（迁移 `0010_tools.sql`：`apps`、`app_tools`、`tool_grants`、`conversation_tool_grants`、`approvals`、`questions`、`tool_outputs`，`runs.status` 增加 `waiting`，`orgs.settings`）、`tools` 配置段与 `http.publicUrl`；组织动作新增 `apps.manage`（admin）、`apps.use`（guest）、`approvals.decide`（guest），均仅限用户主体；错误码 `app.*`、`approval.*`、`question.*`、`tool_output.not_found`、`credential.missing`。

应用凭据（`Credentials`）：信封加密存入 `capybara.secrets`（命名空间 `kernel`，键前缀 `credentials:app:`），支持 bearer / api_key / basic / headers 静态认证注入，读出的值登记日志打码，缺凭据抛 `CredentialMissing`（`credential.missing`）。
