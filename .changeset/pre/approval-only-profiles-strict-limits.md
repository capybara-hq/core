---
"@capybara-hq/plugin-sdk": patch
---

Device protocol: `exec` and `create` `limits` (and their `network`) refuse unknown keys. Protocol 4
removed the `mode` tier, so a stale `limits.mode` is now a protocol error instead of being ignored.
