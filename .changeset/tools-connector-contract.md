---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

新增工具注册与 `connector@1` 契约：插件在 `setup` 期间用 `ctx.tools.register(spec, handler)` 注册工具（名称 `^[a-zA-Z0-9_-]{1,40}$`、描述非空、不可重复，`setup` 之后注册抛错）；SDK 导出 `ToolSpec` / `ToolResult` / `InputRequired` / `ToolError`、`Connector` / `ConnectorSession` 契约，以及纯函数 `validateToolSpec` / `validateInputForm` / `validateAnswer`（表单字段复用 `ParamSchema` 子集，新增导出 `checkParamValue`）。`connector` 登记为多选能力。`PluginHost.tools()` 列出所有已加载插件注册的工具。
