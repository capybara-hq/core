---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Switching a plugin off now switches off the connectors recorded on its install (migration 0129 adds
`connectors.disabled_by_plugin_id`): their endpoint and credentials stay, their tools stop being
offered, and the switch-off preview lists them as disabled with the plugin instead of kept on.
Switching the plugin back on reuses those connectors and switches them back on, except one an org
admin disabled by hand; deleting a connector stays possible and permanent, and a failed install's
rollback still deletes the connectors it created.
