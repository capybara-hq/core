---
"@capybara-hq/testing": patch
---

The model conformance suite checks the cache contract (#974): a `declares a valid cache` case
(`validateModelCache`, exported as `checkCacheDeclaration`), a `cache ttl options` case that sends
the caching request once per declared `ttlOptions` entry with `cacheTtl` set, and the `usage` case
checks `cacheWriteByTtl` with `validateCacheWriteByTtl`.
