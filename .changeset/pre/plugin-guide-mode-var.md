---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin guide` fills `{{mode}}` with the mode rendered, as the kernel's guide route does,
so it is no longer reported unresolved; `--var mode=…` is refused in favour of `--mode`.
