---
"@capybara-hq/kernel": patch
---

`GET /api/v1/orgs/:orgId/extensions` gives every extension's `provides` (the extension point names
only), also to members, whose projection still leaves out config, secrets, the config schema and
the permission list: the 扩展 page sorts members' lists by capability too.
