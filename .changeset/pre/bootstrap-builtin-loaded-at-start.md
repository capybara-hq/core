---
"@capybara-hq/kernel": patch
---

The start loads the extensions the second bootstrap pass installed on its own replica before it
plans template connectors and serves, instead of waiting for the `kernel.plugins.changed` message.
