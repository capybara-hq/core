# Authoring: extension point connector

<!-- generated:extension-point -->
- Name: `connector` (a ref is `connector@<major>`)
- Speaks one protocol (MCP, OpenAPI) to external systems and exposes their tools to agents.
- Providers: several
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: Connector (`connector.ts`)

Implement one protocol (`kind`): an endpoint schema, `open` and `close` per call, `auth()` before every request, and tool listing and calls. Surface failures as `ToolError` with a kind. Tools reach agents as `mcp__<slug>__<tool>`. Templates for it: see `connector-templates`. No stdio MCP.

See `extensions` for the rules every extension follows.
