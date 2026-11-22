---
"@capybara-hq/device": minor
---

`login` adds a connection instead of refusing when the machine is already logged in: each
deployment device gets its own `connections/<deviceId>/`. Logging in again into a device this
machine already serves replaces its credential in place, keeping its working directory, mode and
policy (a differing `--dir` / `--mode` is not applied, and login says so); the same device id
from another deployment URL or organization fails with `device_id_in_use` and stores nothing
(log that connection out first). A device id from the
deployment that is not a safe directory name fails with `invalid_device_id` and stores nothing.
The JSON `done` event carries `replaced`; the credential stores the device and organization
names when they are not empty. The old flat `credential.json` is never read, moved or deleted.
