---
"@capybara-hq/device": patch
---

A cancelled `list` or `scan` whose abort arrives while the sandboxed helper is still being spawned
now kills the helper's process group instead of letting it run to the end.
