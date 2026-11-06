---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/capybara": minor
---

A platform inbox for the super admin: `GET /api/v1/admin/inbox` lists the orgs' requests to the platform (`access` / `import`), plugins whose extension permissions wait for a confirmation, open plugin scope sync failures (recorded per item and org in the new table `plugin_scope_sync_failures`, migration 0082, until a later sync of the pair does not fail) and the latest platform components migration run when it failed plugins or is stuck. The admin console gets a 收件箱 page (`/admin/inbox`) and a sidebar item with its count; each item links to the page where it is acted on.
