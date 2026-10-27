---
"@capybara-hq/plugin-tools": patch
---

The plugin packer ships agent templates (`agents/<name>.md`, listed in `plugin.json` `agents` or
scanned), checks them with `parseAgentTemplate`, and refuses duplicate template names and more than
64 scanned agent templates.
