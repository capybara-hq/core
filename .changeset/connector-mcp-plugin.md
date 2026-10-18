---
"@capybara-hq/plugin-connector-mcp": minor
---

新增 MCP 连接器插件 `@capybara-hq/plugin-connector-mcp`（`connector@1`，kind `mcp`，官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP 客户端）：端点 `{ url, headers }`（url 须为 https；部署配置 `allowInsecureLoopback`（默认 false）打开时才允许确切的 `127.0.0.1` / `localhost` / `[::1]` 用 http；不跟随重定向，3xx 一律报错；headers 为非密钥固定头，不允许 `Authorization` / `Cookie` 等凭据头）；每个 HTTP 请求前调用内核的 `auth()` 合并鉴权头 / query，401 → `onUnauthorized()` 后重试一次，仍失败抛 `ToolError("Authentication failed for this app; ask the user to reconnect it.")`；工具清单映射 `name / description（缺失用 title 或 name 并 warn）/ inputSchema / annotations`（`_meta["anthropic/requiresUserInteraction"]` → `requiresUserInteraction`），调用结果映射 text / image / resource_link，嵌入资源转文本，音频与二进制资源给出类型说明；服务端 JSON-RPC 错误 → `ToolError` 带服务说明，HTTP 非 2xx → `ToolError` 只带状态码、正文（截断）记 warn 日志；服务声明 resources 能力时会话带 `listResources` / `readResource`。会话在单次操作内打开并关闭，不缓存连接。
