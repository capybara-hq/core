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
- Plugin notices (`upload_confirmed`, `upload_rejected`, `item_shared`,
  `shared_item_updated`) carry the plugin's `displayName`; the
  inboxes lead each row with the item's display name, keep its version whole beside it
  (`v0.1.0`) and give the list column more room.
- Plugin and component details are one centred column (facts as a KeyValue, actions and 删除 in
  the head, the license folded at the end); review and detail sections have real headings.
- The `/` skill menu on an agent with no invocable skills explains why and links editors to the
  agent's skills.
