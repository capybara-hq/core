---
"@capybara-hq/plugin-sdk": patch
---

Move the logo SVG viewBox parser into an internal module so its non-backtracking structure is
tested directly; no behavior change.
