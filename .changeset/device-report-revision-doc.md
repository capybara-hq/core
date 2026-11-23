---
"@capybara-hq/plugin-sdk": patch
---

`DeviceReport` and `ctx.devices.reportChanged` docs: the revision must change whenever what was
approved against the report changes; display-only facts may change under the same revision and are
announced with `reportChanged`, which stores the new text without invalidating approvals.
