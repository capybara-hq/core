---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A message may carry `tokens` (connectors, connector resources, library files, project files,
conversations), each marked in `text` with U+FFFC, beside the older reference fields (not both).
The kernel resolves them as the sender before writing: each marker becomes an English placeholder
(`[connector: Slack]`, `[resource: … from …]`, `[file: …]`, `[project file: …]`,
`[conversation: …]`), a named connector adds a mention block (with tool search on, a connector of at
most 20 tools has them loaded from that message), and `payload.inline` / `payload.connectorMentions`
record them. Every file block, uploads included, is now preceded by a `[file: <name>]` line, and a
resource block says "from the connector". New refusals: `conversation.connector_unavailable`
(`not_found`, `needs_config`, `not_offered`) and `connector.resource_unreadable` (`ui_template`,
`empty`), with zh / en copy.
