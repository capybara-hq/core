---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ctx.deviceAccess.ensureService` and `request` hand an extension the device and provider failures
as the sandbox tools say them (an actionable `ToolError`: the provider cannot be reached, the
machine is offline or needs an update, the outcome is unknown, ...), instead of the raw error that
extensions could only report generically. A browser tool on a device whose provider is down now
says what a Bash call says.
