---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

An instance-boundary runtime report that names an `unavailableReason` (a stale image, a digest
mismatch) now reads as unsupported. The SDK adds `instanceSupported(report)`: true only for
`boundary: "instance"` with no reason. The kernel uses it for recorded runtime availability, the
withheld scope, the kernel-read route and the held-operation check, so a network-`none` native
call or execution on such a device is refused instead of running.
