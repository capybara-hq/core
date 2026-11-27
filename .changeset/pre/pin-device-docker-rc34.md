---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Bootstrap pins device-docker 0.1.0-rc.34 (plugins 1f142e1): an instance's egress proxy is replaced
when its image id differs from the configured image's, so a rebuilt image under the same tag reaches
existing instances on resume or next use.
