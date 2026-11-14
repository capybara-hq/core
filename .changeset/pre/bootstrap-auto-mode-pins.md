---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Bootstrap pins move to the plugin versions the official marketplace lists at capybara-hq/plugins
ce9c71ed, the release that ships the auto-mode sandbox network policy (openai-compatible rc.10,
object-store-s3 rc.9, sandbox-docker rc.14, skills-core rc.1, the rest likewise). The compose
sandbox build contexts point at the same commit.
