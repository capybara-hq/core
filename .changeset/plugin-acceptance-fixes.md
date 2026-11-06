---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Plugin and component management acceptance fixes.

- The org's offered components (`GET /api/v1/orgs/:orgId/components`) and a platform skill in the
  org's skill library and detail carry their `owner` (the platform, or the org that owns it). The
  workspace pages name the owner from it everywhere: 本组织 for the org's own upload, the owner
  org's name for another org's shared item, 平台 only for the platform's.
- Row and page head actions show their pending state until the call settles; menus never draw an
  empty group or a stray separator.
