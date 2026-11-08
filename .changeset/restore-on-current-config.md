---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

An extension unloaded because a required extension point lost its provider re-reads its deployment
config when the provider returns: it comes back on the config saved meanwhile, and stays pending
configuration when its config was cleared, instead of returning on the old values and secrets.
