---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Deleting a device whose provider plugin is no longer installed no longer retries forever: the
instance is marked abandoned (migration 0180), its provider-side names are kept on the row and in
a `device.instance_abandoned` platform audit event, and the destroy job finishes.
