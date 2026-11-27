---
"@capybara-hq/kernel": patch
---

Syncing an installed plugin package no longer moves a complete package directory aside that
another replica on the same volume just swapped in. Replicas sharing the plugin directory could
see it vanish for a moment and record `sync_failed` or `import_failed` until the next reconcile.
