---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Plugin icons wherever the kernel shows something a plugin brings: channel connections
(`pluginIcon`, `pluginDisplayName`), org and admin extensions, model providers and the catalog
lists carry the URL of their plugin's icon for the reader's scope (org or admin icon route; null
without one, or when the org may not see the plugin). The web draws it as the mark, falling back to
the initial, and the org channels page is a card list.
