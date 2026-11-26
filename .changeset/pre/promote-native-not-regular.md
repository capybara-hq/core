---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

Step 3 of the runtime change for #907: `SANDBOX_RUNTIME_SOURCE.files` is the current
`native-files.py` again (it answers `NOT_REGULAR_FILE` for a FIFO, device or other special file)
and the staged copy is gone; `accepted` keeps the earlier helper's digest for one revision so
device containers made from an earlier device-docker image stay available until they are
recreated. The bootstrap manifest pins device-docker 0.1.0-rc.33 at plugins 5cb8d1f (the restaged
image), the compose sandbox build contexts follow, and capybara-device's docker mode pins the
sandbox image 0.1.0-rc.33.
