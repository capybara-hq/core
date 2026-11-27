---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Device service installs move to a machine-wide cache (capybara-hq/plugins#311): a service file
`capybara-install-key` (`DEVICE_SERVICE_INSTALL_KEY_FILE`, such as the browser revision) keys the
install, so a plugin upgrade that keeps the key, and every other device of the same deployment and
OS user, reuse the sealed install instead of downloading it again. capybara-device keeps it under
`~/capybara-device/.install-cache` (0700): an install is staged privately, checked (no link out of
it, no special file), digested and renamed into place under a cross-process lock once its service
sealed it; every reuse verifies the digest first and installs again on a mismatch. Entries no
running service uses are removed beyond the two most recently used per service.
