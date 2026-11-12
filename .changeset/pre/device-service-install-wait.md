---
"@capybara-hq/device": patch
---

`capybara-device service install` on macOS waits until `launchctl bootout` has really removed the
old agent before `bootstrap`, and retries a bootstrap that fails with error 5 (Input/output error),
with a clear message when it keeps failing. On Linux a reinstall restarts the unit. `drain --wait
[--timeout <seconds>]` returns once the program has exited.
