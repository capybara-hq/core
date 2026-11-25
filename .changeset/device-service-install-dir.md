---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

`capybara-device` gives every device service an install directory (`<device dir>/svc-install/<id>`,
named by `CAPYBARA_SERVICE_INSTALL`, `DEVICE_SERVICE_INSTALL_ENV`): the service may write it until it
creates the regular file `.sealed` there (`DEVICE_SERVICE_INSTALL_SEAL`), and from its next start on
reads it only, so nothing the service later runs can replace what it installed (the browser plugin's
Chromium, capybara-hq/plugins#209). It is emptied and unsealed when the service's files change, and
agent operations can neither read nor write it.
