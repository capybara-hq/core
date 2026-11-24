---
"@capybara-hq/plugin-sdk": patch
---

`DEVICE_SERVICE_WORKSPACE_ENV` (`CAPYBARA_SERVICE_WORKSPACE`): providers set it for every device
service to the device's workspace root, and services confine the files they take in and let out
(uploads, downloads) to it.
