---
"@capybara-hq/plugin-openai-compatible": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

新增 OpenAI 兼容模型供应商插件 `@capybara-hq/plugin-openai-compatible`（model-provider@2，官方 `openai` SDK 的 `chat.completions` 流式接口 + 可配置 baseURL）：部署配置按端点给出 `baseUrl`、方言（`generic` / `deepseek` / `qwen`）与模型清单，密钥放在顶层 `apiKeys`（端点名 → 密钥，密钥字段；键必须是已配置的端点名），对外模型 id 为 `<端点名>/<模型 id>`。方言预设：DeepSeek 读取 `reasoning_content` 思考增量并按其规则回传（同一端点同一模型的思考随 assistant 消息带回；带 tools 且未关闭思考时，没有本模型思考的回合补空的 `reasoning_content`），`thinking` / `effort` 映射为 `thinking.type` / `reasoning_effort`，`prompt_cache_hit_tokens` 记为缓存读取，`insufficient_system_resource` 按可重试的 server 错误处理；Qwen 的 `thinking` 映射为 `enable_thinking`，缓存写入取 `cache_creation_input_tokens`。工具参数在原始 chunk 上自行累积与解析，收到 finish_reason 后有用量即停、无用量最多再读一个 chunk；SDK 不做重试。内核导出 `assertSecretsReachable`（插件加载时的密钥标记检查）；测试工具新增 `assertPluginSecretsReachable` 与 `pluginDeploymentSecretValues`，供插件测试执行同一检查。
