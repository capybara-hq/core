---
"@capybara-hq/kernel": minor
---

MCP elicitation、prompts 斜杠命令与 `@` 资源引用（D4）：

- **elicitation**：应用工具调用途中远端发起 elicitation 时，内核把它映射成通用输入请求（表单模式按 InputForm 子集映射 `requestedSchema`；URL 模式为带 `url` 的表单与必填的「已完成」开关），**中止本次调用**并让运行等待（`question_asked`，表单经本次注入的凭据打码）；用户回答后照常用同一 input 重新发起调用，远端再次发起同样的 elicitation（表单按 `requestedSchema`、URL 按 origin + path 匹配）时立即用答案答复（超时 / 取消 → `cancel`，URL 未勾选 → `decline`）。超出子集的表单立即 `decline` 并在工具结果后附英文说明；resources 工具一律拒绝。事件 `question_asked.form` 新增可选 `url`。
- **prompts**：`GET /api/v1/orgs/:orgId/apps/prompts`（`apps.use`）列出当前用户可用应用的提示模板（缺个人凭据 / 连接失败的应用列在 `unavailable`）；`POST /api/v1/orgs/:orgId/apps/:appId/prompts/:name {arguments}` 以当前用户的凭据渲染为文本（打码、≤ 100000 字符）。
- **resources**：`GET /api/v1/orgs/:orgId/apps/resources?query=` 按名称 / URI / 描述子串搜索；`POST .../conversations/:id/messages` 新增 `attachments: [{ appId, uri }]`（≤ 5），内核以发送者的凭据读取（打码、每个 ≤ 50000 字符）作为用户文本之后的文本块写入同一条 `user_message`，并在 `payload.attachments` 记录元数据。
