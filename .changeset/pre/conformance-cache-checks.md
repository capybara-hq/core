---
"@capybara-hq/testing": patch
---

The model conformance suite checks the cache contract (#974): a `declares a valid cache` case
(`validateModelCache`, exported as `checkCacheDeclaration`; it also fails when `expect.caching` is
true but the model declares no cache or `mechanism: "none"`), a `cache ttl options` case that sends
a caching request with its own prefix once per declared `ttlOptions` entry with `cacheTtl` set, so
each writes, and checks that reported `cacheWriteByTtl` holds only that ttl (exported as
`checkCacheWriteTiers`), and the `usage` case checks `cacheWriteByTtl` with
`validateCacheWriteByTtl`.
