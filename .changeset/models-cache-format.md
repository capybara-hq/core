---
"@capybara-hq/capybara": patch
---

After an upgrade that added model kinds, a model list cached by the previous kernel made every model
"not available" for up to ten minutes. The cache key now carries the format of the cached list.
