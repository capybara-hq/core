---
"@capybara-hq/plugin-tools": minor
"@capybara-hq/kernel": patch
---

Add `capybara-plugin bootstrap --check|--write` to validate and pin a distribution's extra bootstrap
manifest (git entries are pinned to the kernel's canonical pack), and export `packPackageTgz` from
the kernel.
