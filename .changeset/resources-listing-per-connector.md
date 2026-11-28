---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

A connector session's `listResources` items may carry `size` (bytes). The kernel's resources
listing takes an optional `connectorId` (one session on that connector, refusing one that is not
active or has `read_resource` off). With `connectorId` it also hides MCP app UI templates (`ui:`
URIs, `text/html;profile=mcp-app`) and resources of size 0.
