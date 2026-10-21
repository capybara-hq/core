---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-openai-compatible": patch
---

供应商映射里的附件名与空文本文档：

- SDK 新增纯函数 `clipMediaName(name, max = 200)`（保留短扩展名，中间用 `…`）。
- anthropic：文档 `title` 截短；空的纯文本文档不再发空的 document 块，改发一行英文说明；
  注明 tool_result 在 user 内容开头的顺序由内核保证、插件不重排。
- openai / openai-compatible：PDF 的 `filename` 补 `.pdf` 后截短。
