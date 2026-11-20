---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/capybara": patch
---

A local device's hello names its program run (`programRunId`, random per process). When the machine
reconnects as a new run before answering a request, the kernel ends that request's wait at once with
a tool error saying capybara-device restarted and the result is lost, instead of waiting out the
command's whole timeout plus the reconnect grace.
