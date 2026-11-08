---
"@capybara-hq/capybara": patch
---

A super admin can clear an extension's deployment config (`DELETE
/api/v1/admin/extensions/:name/config`): the values and secrets saved in the admin console are
removed, every replica re-reads, and the extension loads from the startup config or becomes
pending configuration without a restart.
