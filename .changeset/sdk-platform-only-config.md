---
"@capybara-hq/plugin-sdk": patch
---

Deployment config fields are org-overridable by default: `platformOnly(schema)` marks a field, or the
whole deployment schema, that only the platform sets (`"x-platform-only": true` in
`configJsonSchema`, allowed on the root and its top-level properties; `isPlatformOnly` reads it).
`orgAccess`, `orgAccessOf`, `OrgAccess` and `x-org` are removed, and so is the org-only config:
`defineExtension({ config })` takes `deployment` only, and the static manifest and
`extension.configSchemas` have no `org` entry. `web-search@1`, `web-fetch@1` and `directory@1`
drop `orgConfig`: `config` (the effective config for the org) is required and
`configured?(config)` takes it alone.
