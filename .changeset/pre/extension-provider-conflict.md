---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A second enabled provider of a single-provider extension point now shows as a conflict (replica
reason and status `conflict`, naming the provider in the way) instead of a missing dependency, and
loads by itself once the other provider is disabled.
