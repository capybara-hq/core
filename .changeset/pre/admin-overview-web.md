---
"@capybara-hq/web": patch
---

The admin console overview shows what waits (the inbox by type, extensions, plugin updates and
model providers needing a look) and the recent platform-level actions, each section loading and
failing on its own; a new `/admin/audit` page lists the platform audit log, and the platform inbox
can be filtered by type (`?type=`).
