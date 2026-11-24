---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Bootstrap plugins are pinned to the plugins release built on the unified plugin config (core#720):
every pinned extension is repacked without the removed `config.org` list, model providers and
web tools read org-overridable fields per call, and `marketplace.commit` plus the compose sandbox
build contexts move to plugins `1abf9e6`.
