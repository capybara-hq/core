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
`configured?(config)` takes it alone. Their call args gain `orgId` (the org the call is made for),
to pass to `configUrlFetch` or `ctx.net.fetch`.

`configUrlFetch(net, { url, platform, orgId })` returns the `fetch` for a config URL an org may
override: the global `fetch` for the platform's own URL (trailing slashes ignored), `ctx.net.fetch`
for any other.
