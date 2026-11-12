---
"@capybara-hq/device": patch
---

Sandboxed commands no longer get `npm_config_store_dir`, which made every npm command warn
`Unknown env config "store-dir"`; pnpm 10 has no other variable for its store, so it stays at
pnpm's default under the command's HOME.
