---
"@capybara-hq/testing": minor
---

`startFakeMcpServer` 新增 `sessions`（有状态 Streamable HTTP 会话，服务端发起的请求的答复能送回原调用）、`prompts`（`FakeMcpPrompt`：参数与可自定义渲染）；工具处理函数的上下文新增 `elicit(params)`（表单 / URL 模式的 `elicitation/create`，记录在 `FakeMcpServer.elicitations`）；`FakeMcpRpcError` 可带 JSON-RPC `data`（如 `-32042` 的 `elicitations`）。
