---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin marketplace --write` accepts `--base <rev>` and rewrites the entries added since the base whose source differs from the tree's pack, the ones `--check --base` flags as `marketplace-integrity`.
