---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Org admins upload plugins and share what their org owns (plugin scope phase 3, migration 0083).

- An org admin uploads a plugin `.tgz` from the workspace 插件 page (`POST
  /api/v1/orgs/:orgId/catalog/uploads/file`, then review and confirm). A package without an
  extension installs at once, owned by the org; one with an extension waits until the super admin
  confirms that exact package in 待确认 (or rejects it), and so does every later version that carries
  an extension. Plugin and extension names stay deployment-global (`plugin.name_taken` names the
  owner); names of bootstrap and marketplace plugins are reserved for org uploads
  (`plugin.name_reserved`).
- Catalog items and platform components have an owner (平台 or an org). The owner org marks its own
  plugins and skills 可共享; only shareable items can be shown to or associated with other orgs
  (`catalog.not_shareable`), and turning it off keeps the orgs that use it. Shared items follow the
  owner's versions, with inbox notices for the orgs using them.
- An owner deleting an item other orgs use, or an org being deleted, transfers it to the platform
  with a notice in the platform inbox; org skills and agent templates become platform rows when
  first shared, keeping their ids, so agents and logs are unchanged.
- 新建技能: `POST /api/v1/orgs/:orgId/skills` also takes `{ name, description, body }`, and the
  workspace 技能 page creates a skill from text.
- The admin console shows owners, the share gate, org uploads in 待确认 and the new inbox kinds.
