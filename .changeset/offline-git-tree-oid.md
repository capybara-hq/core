---
"@capybara-hq/kernel": patch
---

A `source: "git"` bootstrap entry installed from the offline directory now records the tree oid of
its verified files, as a git read does. Its plugin no longer shows "same version, content changed"
after a commit elsewhere in the marketplace repository.
