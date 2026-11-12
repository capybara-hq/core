---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Sandbox tiers in the kernel: cloud devices get their effective tier (applied on use through the provider's `update`, or by recreating the instance on the kept files), local devices get the org's ceiling with every command, scheduled runs need the `tier:open` task grant for the open tier, and a device running without a sandbox is refused where the org does not allow it
