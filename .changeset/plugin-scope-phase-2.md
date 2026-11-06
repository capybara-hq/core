---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/capybara": minor
---

Plugin scope phase 2: a plugin's skills, agent templates and connector templates are platform
components, stored once for the deployment (migration 0080: `platform_skills`,
`platform_agent_templates`, `platform_connector_templates` and their versions, files under
`deployment/platform/`) and resolved at read time in each org where they are on; an org install no
longer copies skills or agent templates. A component follows its plugin's scope or has its own
(`/api/v1/admin/components/*`, preview then confirm), org admins switch single components off or on
(`PUT /api/v1/orgs/:orgId/components/:kind/:id/switch`), and a super admin uploads a new component
version on its own. The worker job `platform-components-migrate` (migration 0081) links org copies
made by earlier installs to their platform components under their own ids (agent definitions and
conversation logs are not rewritten; a copy changed in the org is pinned to its version) and renames,
in its first run only, an org's own skill whose name a platform skill on in the org has, with an inbox
notice. The per-org plugin upgrade routes are removed: the super admin updates a platform plugin once
(`POST /api/v1/admin/catalog/items/:id/update/preview`, `PUT …/update` with `diffHash`), which moves
its extension, components and every org install; connectors follow their template through
`platform_template_id`, and an org creates connectors for added templates with
`POST /api/v1/orgs/:orgId/catalog/:itemId/connectors`. The admin console gets 技能, 连接器模板 and
智能体模板 pages with scope dialogs and version history, and the plugin detail's platform update
preview.
