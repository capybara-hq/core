---
"@capybara-hq/plugin-tools": minor
"@capybara-hq/kernel": patch
---

Add `capybara-plugin bootstrap --check|--write` to validate and pin a distribution's extra bootstrap
manifest (git entries are pinned to the kernel's canonical pack; every git entry is read from
`--root`, and `--marketplace <name>` limits the run to one marketplace's repository), and export
`packPackageTgz` from the kernel.
