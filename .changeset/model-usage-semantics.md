---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-model-fake": patch
---

明确 `ModelUsage` 语义：`inputTokens` 只是未缓存的输入，输入总量为 `inputTokens + cacheReadTokens + cacheWriteTokens`；`model-fake` 的 `inputTokens` 改为扣除缓存前缀后的部分。
