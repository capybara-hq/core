---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
"@capybara-hq/design": patch
---

The plugin enable wizard opens on a 选择连接器 / "Choose connectors" step when the plugin has more
than one connector template or a default-off one: every template with its icon, name, description
and a mark saying what its step needs (nothing, an OAuth client, an address, a credential). Default-on
templates start checked, default-off ones unchecked, one the org already has a connector for is kept
(locked on); only checked templates get a step and a connector. The org install body
(`PUT …/catalog/:itemId/switch` inputs, `POST …/catalog/:itemId/install`) takes `templatesOn`: the
template ids to switch on with the install; the plugin's other templates are switched off in the org
(audited `component.org_switched`) and stay available on /connectors. Unknown, disabled or not offered
ids are refused (`validation_failed` at `templatesOn`); absent keeps the templates on in the org now.
The Platform operation `plugins.install` takes `templatesOn` too. The design `CheckList` row takes an
optional `mark` (a 24 px mark tile before the name).
