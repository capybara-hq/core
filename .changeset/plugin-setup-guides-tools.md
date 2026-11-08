---
"@capybara-hq/plugin-tools": minor
"@capybara-hq/testing": patch
---

`capybara-plugin pack` (and so `capybara-plugin check`) ships a plugin's setup guide template
files and refuses a missing, oversized or binary one, a placeholder the guide's place does not
define (in a file or a step), and a `channel-connection` guide without an extension. The `fake-im`
test plugin carries a channel setup guide with a file per inbound mode.
