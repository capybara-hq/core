---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Bootstrap contract (migration 0178): a recorded run counts as done only while the latest completed
run has the same extra-manifest part, so an extra manifest added back after its removal runs again
and restores `required` / `builtin` (#534). A run records itself as started before its first write
(`bootstrap_run_started`, with its extra entries), so a process without
`CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST` is refused from the first pass of an npm-only extra manifest on
(#533). `BootstrapService.isDone` takes the manifest instead of its sha256.
