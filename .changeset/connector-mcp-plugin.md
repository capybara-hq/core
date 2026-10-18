---
"@capybara-hq/plugin-connector-mcp": minor
"@capybara-hq/testing": minor
"@capybara-hq/kernel": minor
---

新增 MCP 连接器插件 `@capybara-hq/plugin-connector-mcp`（`connector@1`，kind `mcp`，官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP 客户端）：端点 `{ url, headers }`（url 须为 https；部署配置 `allowInsecureLoopback`（默认 false）打开时才允许确切的 `127.0.0.1` / `localhost` / `[::1]` 用 http；不跟随重定向，3xx 一律报错；headers 为非密钥固定头，不允许 `Authorization` / `Cookie` 等凭据头）；每个 HTTP 请求前调用内核的 `auth()` 合并鉴权头 / query，401 → `onUnauthorized()` 后重试一次，仍失败抛 `ToolError("Authentication failed for this app; ask the user to reconnect it.")`；工具清单映射 `name / description（缺失用 title 或 name 并 warn）/ inputSchema / annotations`（`_meta["anthropic/requiresUserInteraction"]` → `requiresUserInteraction`），调用结果映射 text / image / resource_link，嵌入资源转文本，音频与二进制资源给出类型说明；服务端 JSON-RPC 错误 → `ToolError` 带服务说明，HTTP 非 2xx → `ToolError` 只带状态码、正文（截断）记 warn 日志；服务声明 resources 能力时会话带 `listResources` / `readResource`。会话在单次操作内打开并关闭，不缓存连接。

内核：迁移 `0013_app_tools_source.sql` 给 `app_tools` 加 `source`（`connector` / `resources`）；应用安装 / 刷新时会话支持 resources 则补上 `<slug>__list_resources`、`<slug>__read_resource {uri}` 两个只读工具（默认 allow，可像其他工具一样启停与改策略；连接器自带同名工具时连接器的优先），执行时路由到会话的 resources 方法；应用工具视图新增 `source`。工具管线在写事件 / 存档之前用本次调用实际注入的凭据值给应用工具的结果与错误打码（与 logger 同一匹配器；按调用打码下限 6 个字符，并含百分号编码形式；同一套展开也登记进 logger 的组织来源集合，仍只收 ≥ 12），安装 / 刷新时的工具清单同样打码；`log.ts` 导出 `createRedactor`。刷新时工具来源变化（resources ↔ connector）按新注解重新推导默认策略。

测试工具新增 `startFakeMcpServer({ tools, resources?, requireBearer?, unauthorizedTimes?, onCall?, intercept? })`（SDK 服务端、无状态 Streamable HTTP、127.0.0.1 随机端口；可模拟慢、报错、回显请求头、超大输出、401）与 `FakeMcpRpcError`。
