---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`DEVICE_SERVICE_WORKSPACE_ENV` (`CAPYBARA_SERVICE_WORKSPACE`): providers set it for every device
service to the device's workspace root, and services confine the files they take in and let out
(uploads, downloads) to it. `DeviceServiceStatus` gains optional `codeDir`, the directory the entry
runs from when the provider keeps code apart from state (absent: the state directory); the kernel's
launch review shows `node <codeDir ?? stateDir>/<entry>`, still in the state directory.
