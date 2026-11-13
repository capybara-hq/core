---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Turning a plugin back on no longer asks for the input of a connector template whose connector an
earlier switch-off kept: the org item detail marks such a template `connected` and the enable wizard
skips its step, saying the existing connector is kept (the install reuses it unchanged); an install
whose kept connector is deleted between planning and running now fails with
`catalog.connector_removed` (retry it) instead of finishing without a connector.
