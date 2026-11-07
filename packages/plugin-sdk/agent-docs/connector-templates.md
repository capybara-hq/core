# Connector templates

A connector template is a ready-made connection to an external system: a protocol connector
(`connector-mcp`, `connector-openapi`), a preset endpoint and the auth shape. An org installs it
and fills in only the credential. Templates live in a plugin as `connectors/<id>.json`; the id is
the file's base name.

```json
{
  "$schema": "https://capybarahq.com/schemas/connector-template.v1.schema.json",
  "displayName": { "zh": "Acme CRM", "en": "Acme CRM" },
  "description": "Acme CRM over MCP",
  "template": {
    "plugin": "connector-mcp",
    "pluginVersion": "^0.1.0-rc.0",
    "connector": "mcp",
    "endpoint": { "url": "https://mcp.acme.example/mcp" },
    "editableEndpoint": ["url"],
    "auth": { "type": "bearer", "ownership": "org" },
    "defaultToolPolicies": { "search": "allow", "delete_record": "deny" }
  }
}
```

The file is strict. Top-level fields:

<!-- generated:connector-template -->
| Field | Type | Required |
|---|---|---|
| `displayName` | object | yes |
| `description` | string | no |
| `icon` | string | no |
| `template` | object | yes |
<!-- /generated -->

Fields of `template`:

- `plugin`, `connector`: the connector extension and its kind; `pluginVersion` is a semver range.
- `endpoint`: the preset every org sees. **Never put credentials in it** (no `token`, `apiKey`,
  `secret`, `password`, `authorization`, `cookie`).
- `editableEndpoint`: dotted endpoint paths an org may change at install (a self-hosted URL, a
  tenant id). List only what really differs per org.
- `auth`: the auth method without credentials: `none`, `bearer`, `basic`, `api_key`, `headers`,
  `oauth_code` or `oauth_client`, plus `ownership` (`org` or per member).
- `defaultToolPolicies`: tool name to `allow`, `ask` or `deny`. When unsure, do not write `allow`.

Credentials and secret config are entered by people on the web page, never through an agent.
