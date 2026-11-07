---
"@capybara-hq/kernel": patch
---

Orgs may keep their own copy of an extension's overridable deployment config
(`/api/v1/orgs/:orgId/extensions/:extension/overrides`: view, save, take, reset); platform secrets
never enter a copy. The org extension list reports `overrideState` and `needsConfig`, and the admin
lists the org copies of an extension (`/api/v1/admin/extensions/:name/org-overrides`).
