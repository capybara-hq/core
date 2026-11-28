---
"@capybara-hq/kernel": patch
---

Deleting a plugin from the platform catalog switches off the connectors its connector templates
made, as an uninstall does (endpoint and credentials kept). Importing the same plugin again moves
those connectors to the new catalog item, so they show their icon and description again, and the
new item's install switches back on the ones the delete switched off; one an org admin disabled by
hand stays off.
