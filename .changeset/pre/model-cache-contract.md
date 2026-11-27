---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-model-fake": patch
"@capybara-hq/testing": patch
---

Declare prompt caches per model (#974). `ModelInfo.cache` (`ModelCacheInfo`: `mechanism` explicit /
implicit / none, `ttlOptions` in seconds, `defaultTtl` (required when `ttlOptions` is non-empty),
`ttlIsMinimum`, `refreshOnHit`, `ttlClock`,
`minTokens`, `guaranteed`; absent = none; checked by `validateModelCache`) replaces
`capabilities.caching`, which is removed. `ModelRequest.cacheTtl` asks for one of the model's
`ttlOptions`; `ModelUsage.cacheWriteByTtl` (`CacheWriteByTtl[]`, summing to `cacheWriteTokens`;
`validateCacheWriteByTtl`) reports cache writes per lifetime tier. model-fake and the test fixtures
no longer declare `capabilities.caching`.
