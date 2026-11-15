---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An organization's sandbox network follows the platform: it stores the hosts it adds and drops
(`cloudNetwork: { mode?, base?, extraHosts?, excludedHosts? }`) instead of a copy of
`sandbox.limits.allowHosts`, and approving a network request adds only the requested hosts, so
platform changes keep reaching it. The new `sandbox.limits.orgHosts: within` makes the platform
allowlist a ceiling organizations cannot go beyond (default `extend`). The settings responses carry
the computed `effectiveNetwork`; `deployment.cloudNetwork` is now `{ allowHosts, orgHosts, off }`.
Migration 0134 keeps each organization's current list exactly; see docs/deploy/upgrade.md.
