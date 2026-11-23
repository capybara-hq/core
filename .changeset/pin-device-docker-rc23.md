---
"@capybara-hq/capybara": patch
---

The image pins device-docker rc.23 (`@capybara-hq/plugin-device-docker@0.1.0-rc.23`): the provider's
own scripts run on a root-owned system PATH, so a tool planted in a writable PATH directory can no
longer lift the in-sandbox time limit or run as root (capybara-hq/plugins#106).
