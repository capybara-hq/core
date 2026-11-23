---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

A device provider that finds its instance gone before a managed operation reached the machine
throws `DeviceRequestNotSentError` with the `SandboxGoneError` as its `cause`: the operation is
recorded as not started (the model is told nothing ran and may retry) instead of an unknown
outcome, and the kernel rebuilds the instance at once so the retry runs on it.
