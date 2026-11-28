---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Prompt suggestions share the prompt cache with the run again: tool definitions read back for a
rebuilt request keep the key order they were sent with (`tool_specs.spec_text`, migration 0200;
jsonb had reordered the input schemas, so every suggestion re-wrote the whole history), and the
suggestion's usage event keeps the provider's per-lifetime cache write split.
