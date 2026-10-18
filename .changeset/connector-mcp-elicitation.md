---
"@capybara-hq/plugin-connector-mcp": minor
---

MCP elicitation、prompts：内核提供 `onElicit` 时声明 elicitation 能力（表单 + URL 两种模式），把服务发起的 `elicitation/create` 交给 `onElicit` 并原样回复答复；工具调用返回 `-32042`（URL elicitation required）时逐个交给 `onElicit`，全部接受后重试一次调用（没有 `onElicit` 或用户未完成 → 英文 ToolError 说明需要的浏览器步骤）。服务声明 prompts 能力时会话带 `listPrompts` / `getPrompt`（内容块按工具结果的规则映射）。
