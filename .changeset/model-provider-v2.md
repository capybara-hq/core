---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-model-fake": patch
---

新增 `model-provider@2` 契约：模型在 `ModelInfo.parameters` 中声明自己支持的参数（受限 JSON Schema 子集；标准旋钮 `effort` / `thinking` / `temperature` / `maxOutputTokens`，厂商专有参数键为 `<插件名>.<名称>`，文案 `{ zh, en }`），请求经 `ModelRequest.params` 传参；SDK 提供纯函数 `validateParams` / `sanitizeParams` / `assertValidDeclarations`。旧契约改名为 `ModelProviderV1` / `ModelInfoV1` / `ModelRequestV1`，`capabilities.effort` 标为弃用。内核同时支持 `@1` 与 `@2`：`@1` 经适配层由 `capabilities.effort` 推导 effort 旋钮（五档，默认 high）并把 `params.effort` 映射为 `req.effort`；`@2` 的声明不合规时该供应商不可用；同一插件两者都提供时用 `@2`。`PluginHost.list()` 的每项新增 `capability`（完整能力引用）。一致性套件支持 `contract: 2` 并新增 `declares valid parameters` 用例。现有插件仍提供 `@1`，仅改用 `*V1` 类型名。
