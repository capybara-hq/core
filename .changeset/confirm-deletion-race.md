---
"@capybara-hq/kernel": patch
---

A super admin confirming an org upload while the org is deleted (or the plugin removed) no longer
fails with 500: the install locks the catalog item row before the per-name install lock, the
order the removal takes them in, so the two cannot deadlock; and a confirmation whose extension
the removal's cleanup took out under it answers 409 `catalog.item_removed`, not 404
`extension.not_found`.
