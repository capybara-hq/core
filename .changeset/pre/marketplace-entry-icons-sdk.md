---
"@capybara-hq/plugin-sdk": minor
---

A `marketplace.json` entry may carry `icon`: an absolute `https://` URL whose path ends in `.svg` /
`.png`, or a `./<path>.svg|png` inside a git marketplace's repository (read at the refreshed
commit). Display only; the SDK exports `marketplaceEntryIcon`, `MARKETPLACE_ICON_RE` and
`MARKETPLACE_LIMITS.iconBytes` (the plugin icon limit), and the JSON Schema has the field.
