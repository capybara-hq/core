---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

Device service rolls (an extension upgraded while its service runs), follow-ups:
`deviceServiceFilesDigest` caches per files object, and `DEVICE_SERVICE_FILES_DIGEST_VECTOR` pins the
digest for every implementation (capybara-device now uses the SDK's). The kernel never rolls a
service to the files of a draining instance, of another package than the replica runs or than the
deployment enabled, and keeps a service that answers the new roll check (`DEVICE_SERVICE_ROLL_CHECK`,
`parseRollCheck`, `isRollCheck`) busy. A provider that keeps the old files after the start is
refused with the cause instead of every later call being reviewed again. The
`device.service_started` audit row says `reason` (`start` or `files_changed`), the files digest and
what a roll replaced, and a call that finds the row of the same start writes none.
