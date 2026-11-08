---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

One name: devices. The program says device everywhere: `credential.json` holds `deviceId` (a file
from an older version is unusable: run `capybara-device logout` and log in again), the default
directory is `~/capybara-device/<deviceId>`, the sign-in follows the kernel's `device_sign_in.*`
error codes, and `status` prints `device`. SDK doc comments say device instead of environment.
