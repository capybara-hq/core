---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

A device service keeps running after its extension is upgraded no longer: the provider reports the
files a running service was started from (`DeviceServiceStatus.filesDigest`, the new
`deviceServiceFilesDigest`), and `ctx.deviceAccess.ensureService` treats a service running other
files like a stopped one: the start is reviewed, then the provider restarts it on the new files.
capybara-device restarts a running service whose ensure names other files (its `filesDigest`, or
the digest of the files sent) and reports the digest in its status. Providers that report no digest
keep the old behaviour; device-local passes it through from its next release.
