---
"@capybara-hq/plugin-tools": patch
---

The plugin toolchain bundles the released kernel and SDK again: a rebuild against the auto-mode
contract (`@capybara-hq/kernel` 0.1.0-rc.29, `@capybara-hq/plugin-sdk` 0.1.0-rc.22) so that
`capybara-plugin check` / `pack` / `release` accept plugins written for `SandboxLimits.mode` and
`limits.network` instead of the removed sandbox tiers.
