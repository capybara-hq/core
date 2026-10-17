---
"@capybara-hq/plugin-openai": minor
---

新增 OpenAI 模型供应商插件 `@capybara-hq/plugin-openai`（model-provider@1，官方 SDK + 原生 Responses API）：`store: false` 并以 `encrypted_content` 回放推理项，中途 system 转为 `developer` 输入项，模型列表由部署配置给出；effort 原样透传，用量含缓存写入，可用 `reasoningSummary: "off"` 关闭推理摘要。
