---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Model-visible tool keys of connectors are `mcp__<slug>__<tool>` and those of extensions
`plugin__<plugin>__<tool>` (aligned with Claude Code). The SDK exports `parseToolKey`,
`connectorToolKey`, `extensionToolKey`, `ParsedToolKey` and `BUILTIN_TOOL_NAME_RE`; hook payloads'
`toolKey` carry the new keys, so an extension that matches keys should use `parseToolKey`.
