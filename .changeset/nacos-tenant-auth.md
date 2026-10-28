---
"@capybara-hq/kernel": patch
---

The Nacos config source also sends `tenant` with its config and listener requests, so a Nacos
2.3 user granted only the configured namespace can read it (Nacos authorizes by `tenant` and
answered 403 before).
