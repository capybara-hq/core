---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Installing, enabling and the scope sync of a plugin ask for no connector input: every connector
template on in the org becomes a connector without an outbound call (its tool list follows through
the outbox), one that needs an org credential or OAuth client waits as `needs_config` until an org
admin configures it, a personal static one is ready for members to connect. The install and switch
bodies no longer take `connectors`, `POST …/catalog/:itemId/connectors` and the Platform operation
`plugins.configure-connectors` are gone, `plugins.install` asks for no secrets, and
`plugins.set-enabled` switches on plugins with templates. The scope sync installs plugins with
templates in every org; a plugin's own `needs_config` state comes only from an invalid effective
extension config. An install's connectors take the first free name and slug, so an org connector
of the same slug no longer blocks it. The import review gains each connector template's icon and
the connectors each agent template needs.
