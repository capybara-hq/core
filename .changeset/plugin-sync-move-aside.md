---
"@capybara-hq/kernel": patch
---

Unpacking a plugin package no longer deletes a broken package directory in place: it is renamed
aside and checked again, so a process sharing the plugin directory can't delete a complete
directory that another process swapped in after its check.
