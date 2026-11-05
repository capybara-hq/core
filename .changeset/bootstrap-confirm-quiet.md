---
"@capybara-hq/kernel": patch
---

The catalog's pending check reads only the packages of the items it shows: a bootstrap confirm no
longer reads every installed extension package before the object store is loaded and no longer
logs a warning with a stack for each one it cannot read yet.
