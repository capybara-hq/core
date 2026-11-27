---
"@capybara-hq/plugin-model-fake": patch
---

model-fake declares a prompt cache by default (explicit, TTL options 300 and 3600, default 300) and
honors `ModelRequest.cacheTtl`: a cache write reports `cacheWriteByTtl`, the kv hit record lives for
the chosen TTL. A model configured with `cache: "none"` declares no cache and counts no cache
tokens; `cache` also accepts a full `ModelCacheInfo` per model.
