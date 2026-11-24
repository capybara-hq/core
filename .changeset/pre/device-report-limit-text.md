---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A device report's limit value is text now: `DeviceReportLimit.value` is `DeviceText`
(`{ en, zh? }`, at most 60 characters per language, checked by `parseDeviceReport`) instead of a
string, so a provider can translate words in it; a string value no longer passes. Migration 0179
turns the string values of stored reports into `{ en }`, and the device page shows each value in
the UI language.
