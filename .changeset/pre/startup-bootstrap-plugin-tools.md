---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin pack --bootstrap` (and its `--root`, `--registry` and `--npm-token` options) and
`packBootstrap` are removed: a starting kernel downloads the bootstrap plugins itself. The pinned
npm download `downloadPinnedNpmPackage` stays (`check:bootstrap --network` uses it).
