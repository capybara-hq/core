---
"@capybara-hq/plugin-anthropic": minor
"@capybara-hq/plugin-openai": minor
"@capybara-hq/plugin-openai-compatible": minor
"@capybara-hq/plugin-model-fake": minor
---

支持 `ModelRequest.toolChoice`：`"none"` 时照常发送工具定义但禁止调用——anthropic 映射为 `tool_choice: {type: "none"}`，openai（Responses）与 openai-compatible 映射为 `tool_choice: "none"`；`"auto"` / 缺省或没有工具时不发送该字段。model-fake 在 `toolChoice: "none"` 时不产出工具调用（`tool:` 指令改为说明文本，默认的「调用第一个工具」改为普通回复），并声明 `capabilities.tools: true`（它本来就能产出工具调用，内核对 `tools: false` 的模型不再发送工具）。
