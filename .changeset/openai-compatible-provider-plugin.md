---
"@capybara-hq/plugin-openai-compatible": minor
---

新增 OpenAI 兼容模型供应商插件 `@capybara-hq/plugin-openai-compatible`（model-provider@2，官方 `openai` SDK 的 `chat.completions` 流式接口 + 可配置 baseURL）：部署配置按端点给出 `baseUrl`、`apiKey`（可选，密钥字段）、方言（`generic` / `deepseek` / `qwen`）与模型清单，对外模型 id 为 `<端点名>/<模型 id>`。方言预设：DeepSeek 读取 `reasoning_content` 思考增量并按其规则回传（同一端点同一模型的思考随 assistant 消息带回，带 tools 的请求必需），`thinking` / `effort` 映射为 `thinking.type` / `reasoning_effort`，`prompt_cache_hit_tokens` 记为缓存读取；Qwen 的 `thinking` 映射为 `enable_thinking`，缓存写入取 `cache_creation_input_tokens`。工具参数在原始 chunk 上自行累积与解析，收到 finish_reason 与用量后即停止读取；SDK 不做重试。
