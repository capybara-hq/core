---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Plugin icons, connector template icons and setup guide files are kept in PG (`catalog_files`,
migration 0100) instead of object storage, so a bootstrap plugin that ships an icon imports before
any object store runs and a deployment without an object store still shows icons and guides. The
staging cleanup removes the ones nothing lists any more.
