---
"@capybara-hq/capybara": patch
---

Ask for the long prompt cache tier per request when `promptCache.longTtl` is on, record it in the
model call and replay it with zero drift.
