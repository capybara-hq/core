---
"@capybara-hq/plugin-sdk": minor
---

`BACKGROUND_LAUNCH_LINE` and `isBackgroundLaunch` are removed. They marked the old session-id
background launcher's command, which no kernel sends any more: a background task starts through
the device's `backgroundStart` operation.
