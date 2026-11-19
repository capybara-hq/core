---
"@capybara-hq/kernel": patch
---

Toggling the platform's `devices.outsideSandbox` or an org's `outsideSandbox` no longer updates
every running cloud instance. The kernel-only mode recorded with a cloud instance's limits still
follows that setting, but it never reaches a provider, so a running instance changes only for its
network (`sameApplied` and `appliedWider` compare the network only); before, every cloud device got
a provider update on its next use, and a Docker container lost its egress proxy. Migrations `0165`
and `0166` add their CHECK constraints `NOT VALID`, then validate them. The notes about
`owner_full_access` now say what still reads it (the one-time conversions and the recorded mode).
