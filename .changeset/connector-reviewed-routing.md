---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-connector-openapi": minor
---

调用按已复核的定义路由（Ruling A21）：`ToolSpec` 新增可选的不透明字段 `connectorData`（仅连接器工具），内核把它存进快照（`app_tools` / `tool_specs`）并计入 spec_hash，但从不发给模型；`ConnectorSession.callTool` 新增可选第 4 个参数 `ctx: { spec }`，内核传该工具已复核的定义（`app_tools.spec`，绝不是待复核的新定义）。connector-openapi 在 listTools 时把方法、路径模板、参数位置与风格、请求体媒体类型、解析好的服务器地址写进 `connectorData`，调用只按 `ctx.spec.connectorData` 构造请求、不再读取文档（缺失时提示管理员刷新应用）——远端文档改了方法 / 路径会改变指纹、进入漂移复核，复核通过前仍走旧路由；文档只在 listTools / inspect 时读取。

应用列表与详情的 `endpoint` 不再回显 `text` / `*Text` 字段全文（如 OpenAPI 的 `specText`），换成 `<field>Bytes` 与 `<field>Sha256`（所有人一致；要改文档时重新上传）。
