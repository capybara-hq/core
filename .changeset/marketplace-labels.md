---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Marketplace labels: the official marketplace is named "Capybara" (it was "Official marketplace" /
"官方市场"), and a marketplace managed by the deployment config (an extra bootstrap manifest)
shows the `owner.name` of its marketplace.json once a refresh has read it, instead of its config
key. The config key stays the row's name, its id (`config:<name>`) and its token's env name.
