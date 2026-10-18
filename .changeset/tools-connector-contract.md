---
"@capybara-hq/plugin-sdk": minor
---

新增工具注册与 `connector@1` 契约：插件在 `setup` 期间用 `ctx.tools.register(spec, handler)` 注册工具（名称 `^[a-zA-Z0-9_-]{1,40}$`、描述非空、不可重复，`setup` 之后注册抛错）；SDK 导出 `ToolSpec` / `ToolResult` / `InputRequired` / `ToolError`、`Connector` / `ConnectorSession` 契约，以及纯函数 `validateToolSpec` / `validateInputForm` / `validateAnswer`（表单字段复用 `ParamSchema` 子集，新增导出 `checkParamValue`）。`connector` 登记为多选能力。

`ModelRequest` 新增可选 `toolChoice: "auto" | "none"`（`model-provider@2`；`ModelRequestV1` 不含，内核的 `@1` 适配层不传）；`ToolError` 新增可选第二个参数 `{ kind?: "error" | "unavailable" }`（缺省 `error`，`unavailable` 表示远端不可用、计入应用熔断），原有用法不变；`validateAnswer` 只认答案自身的键（`Object.hasOwn`），并拒绝多选字段里的重复项。
