---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-tools": patch
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
deprecated version as newer or as an item's latest marketplace version, picks the newest stable
non-deprecated compatible version when an import names none, and refuses importing or requesting a
deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
