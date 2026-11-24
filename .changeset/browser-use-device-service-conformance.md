---
"@capybara-hq/testing": patch
---

`runDeviceServiceConformance(fixture)` checks a device provider's services against one running
instance, with every `ifRunning` ensure sending the name-only spec the kernel sends
(`{ name, runtime: "node", entry: "", args: [], files: {} }`): an `ifRunning` ensure of a stopped
service starts nothing and answers `stopped` with an absolute, stable `stateDir` (and `codeDir`
when reported); a normal ensure starts once; an `ifRunning` ensure keeps a running one running;
the service runs `<codeDir ?? stateDir>/<entry>` (its echo service, `DEVICE_SERVICE_ECHO_SCRIPT`,
answers `DEVICE_SERVICE_ARGV_PROBE` with its `process.argv[1]`); requests round-trip; `stopService`
stops it. Every provider with services must pass it.
