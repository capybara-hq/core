---
"@capybara-hq/plugin-sdk": patch
---

`validateClientSection` refuses an asset path with a segment outside `[A-Za-z0-9._-]` (such as a
literal `%2e%2e`, which the kernel's exact-key delivery never serves) and an asset without a file
name before its extension (`.png`). `validateUiView` refuses component view `data` that JSON would
silently drop or rewrite (functions, NaN or Infinity, `undefined` in an array, Maps, Dates, cycles);
an `undefined` object property is still accepted. A `permissions.client` without a client section
is reported with the same plain text as the forward case.
