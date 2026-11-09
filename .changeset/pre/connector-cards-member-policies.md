---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

The workspace 连接器 page is cards: every connector, and every connector template of a plugin on in
the org that has no connector yet, switched off or not. Org admins 启用 a template and go straight
to its input (补充配置); members 连接 a personal connector and, once connected, set 权限: their own
允许 / 询问 / 禁止 per tool for their connection (`GET` / `PUT …/connectors/:id/tool-policies/me`,
migration 0104). A connector tool call resolves the org's lock, the member's 禁止, the agent's
setting (which may now be `allow` for a connector tool), the member's 允许 / 询问, then the org
default. Connector templates and connectors show their plugin's icon, and the admin connector
templates list and detail show the template's display name with the id as meta.
