---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Device reports can say how to change a device's limits: `DeviceReport.changeHint` (`{ en, zh? }`,
in the provider's words). The device page shows it under the limits, and the kernel appends it to
the refusals that cite the report (an escalated call the device does not allow now, a network the
device side keeps on the allowlist). A provider's permission support may name who keeps a closed
crossing closed (`limitedBy: { outsideSandbox?: "owner", openPublic?: "owner" }`): the kernel then
names the owner of the machine the device runs on instead of the provider.
