---
"@capybara-hq/device": patch
---

A `service.ensure` with `ifRunning` accepts the name-only spec device-local sends; the browser no
longer fails on a local device with "spec.args must be a string array".
