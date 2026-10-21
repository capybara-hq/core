---
"@capybara-hq/plugin-anthropic": minor
"@capybara-hq/plugin-openai": minor
"@capybara-hq/plugin-openai-compatible": minor
"@capybara-hq/testing": minor
---

模型插件支持图片与文档输入（user 消息里的 `image` / `document` 块）：

- `anthropic`：图片映射为 base64 `image` 块，PDF 为 base64 `document` 块，`text/*` 为纯文本 `document` 块（带附件名 `title`）；`capabilities.documents` 取 Models API 的 `pdf_input`。模型信息 kv 键改为 `models:v3:<id>`。
- `openai`：图片映射为 `input_image`（data URL），PDF 为带 `filename` 的 `input_file`，`text/*` 解码为标出文件名的 `input_text`；模型配置新增可选 `documents`（缺省 false）。
- `openai-compatible`：图片映射为 `image_url`（data URL），PDF 为 `file` 内容（仅 generic、qwen 方言），`text/*` 解码为文本；端点模型配置新增可选 `documents`（缺省 false），deepseek / ark 方言开启会被配置校验拒绝。
- 三个插件收到未解析的附件引用（`ref`）时抛不可重试的 `invalid_request`。
- 测试工具：一致性套件新增「带图片 / PDF / 文本文档的 user 消息」用例（按模型声明的 `vision` / `documents` 才跑），新增导出 `MEDIA_SAMPLES`、`redPngBase64`、`solidPngBase64`、`pdfBase64`、`isPngBase64`、`pdfSampleWord`。
