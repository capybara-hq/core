---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Device service installs move to a machine-wide cache (capybara-hq/plugins#311): a service file
`capybara-install-key` (`DEVICE_SERVICE_INSTALL_KEY_FILE`, lower case, such as the browser revision)
keys the install, so a plugin upgrade that keeps the key, and every other device of the same
deployment (URL origin and path) and OS user, reuse the sealed install instead of downloading it
again. capybara-device keeps it under `~/capybara-device/.install-cache` (0700), scoped by the full
sha256 of the deployment, platform, architecture and the launcher's install variant. An install is
staged privately and published only once its service exits sealed: every link resolved inside the
tree, no hard link, no special file; it is digested and renamed into place under a fresh name
under a cross-process lock (generation files, holders named by pid and start time). Every reuse
verifies the digest and installs again on a mismatch. Entries no running service uses are removed
beyond the two most recently used per service, best effort and outside the lock.
