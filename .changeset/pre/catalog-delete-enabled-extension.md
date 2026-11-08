---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Deleting a platform plugin whose extension is still enabled is refused with 409
`catalog.extension_enabled` (disable the extension first, as an uninstall requires); the admin
plugin page says so in the delete confirm and links to the extension.
