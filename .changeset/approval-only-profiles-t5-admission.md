---
"@capybara-hq/kernel": patch
---

The device sandbox is the same under every permission profile: one pure function
(`effectiveDeviceSandbox`) combines the platform, org, device and provider layers into the sandbox
network (open public internet, allowlist or closed), the allowlist hosts (a device's own list only
narrows its org's hosts) and whether a call may run outside the sandbox. Admission no longer branches
on the profile: Full access commands run sandboxed, and only an escalated call within the
outside-sandbox ceiling gets the device filesystem and the environment network. Every supported
recorded permission context carries its `sandbox` block. Instance-boundary providers (the instance is
the sandbox) are supported with a whole-instance scope and no outside. Narrowing a network ceiling to
the allowlist (platform, org, owner or device) revokes running open-network work through the outbox,
an owner network change is published, audited and resets Full consent, the exec limits sent to a
device no longer carry the kernel's mode tier, and a device program newer than the deployment is told
to have the deployment upgraded. Migration `0165` copies allowlist snapshots taken after `0163` into
the device's own network.
