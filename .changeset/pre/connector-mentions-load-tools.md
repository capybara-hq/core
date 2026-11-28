---
"@capybara-hq/kernel": patch
---

A connector named with an inline token loads its tools under tool search: request building adds the
mention's recorded `loadedTools` to the loaded set, from that message on.
