---
"@capybara-hq/plugin-sdk": minor
---

MCP 交互（D4）：`ConnectorOpenArgs` 新增可选回调 `onElicit(request)`（远端在调用途中向用户要输入时调用，返回答复）；新增类型 `ElicitationRequest`（`form`：`message` + `requestedSchema`；`url`：`message` + `url` + `elicitationId`）与 `ElicitationResponse`（`accept` 带可选 `content` / `decline` / `cancel`）。`ConnectorSession` 新增可选方法 `listPrompts()` / `getPrompt(name, args)` 与类型 `PromptInfo`、`RenderedPrompt`。`InputForm` 新增可选 `url`（需要用户打开的外部页面，`validateInputForm` 只接受 ≤ 2000 字符的 http(s) 绝对地址）。旧连接器 / 旧内核不提供这些也照常工作。
