---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-tools": minor
---

Add the setup guide place `device-connection` (member audience; variables `publicUrl`, `orgId`,
`orgName`, `pluginName`) and the `::shell-action connect-this-machine <label>` directive, so device
provider plugins can ship connection guides. Rendered guides carry a `shell-action` block; at most 4
per document, allowed only in this place. The kernel serves these guides to org members
(`agents.use`). `capybara-plugin guide` prints shell actions.
