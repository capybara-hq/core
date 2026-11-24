---
"@capybara-hq/testing": patch
---

`runDeviceServiceConformance(fixture)` checks a device provider's services against one running
instance: an `ifRunning` ensure of a stopped service starts nothing and answers `stopped` with an
absolute, stable `stateDir`; a normal ensure starts once; requests round-trip its echo service
(`DEVICE_SERVICE_ECHO_SCRIPT`); `stopService` stops it. Every provider with services must pass it.
