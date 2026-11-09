---
"@capybara-hq/kernel": patch
---

A super admin confirming an org upload while the org is deleted, the plugin removed or a
replacement version uploaded no longer fails with 500: every path takes the catalog item row
before the per-name install lock (the extension install, the import confirm, the plugin delete),
so none of them can deadlock. A confirmation whose item was removed under it answers 409
`catalog.item_removed` (refused before installing anything, and also when the removal's cleanup
took the extension out between its steps, for a first or a new version) instead of 404
`extension.not_found`.
